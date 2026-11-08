"""Claude vision damage detector: photos -> DamageFinding list.

Install with `pip install -e '.[vision]'`. One request per photo; the model is constrained by a
JSON schema to our panel and damage-type values. Damage that maps to no panel we model
(wheels, mirrors, lights, interior) is kept as notes for the human checker instead of being
forced onto a wrong panel.

Credentials come from the environment the Anthropic SDK reads (ANTHROPIC_API_KEY or an
`ant auth login` profile); this module never reads key files.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
from pathlib import Path as FsPath
from typing import Any

from underscope.coverage import VIEWS
from underscope.models import DamageFinding, DamageType, Panel, VehicleRecord
from underscope.perception import merge_findings

MODEL = "claude-opus-5-5"
# Server-side refusal fallback ("default" routes by refusal category). Car photos shouldn't
# trigger refusals, but a declined photo then still gets an answer instead of failing.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Claude Opus 5.5 list price, USD per million tokens (input, output), from Anthropic's model
# table. Used only to estimate and report what an evaluation run costs.
PRICE_PER_MTOK = (4.00, 20.00)
# Rough tokens per photo for the pre-run estimate: a downscaled image plus the prompt in, and
# the findings JSON plus thinking out. Actual usage is reported after the run.
EST_TOKENS_PER_PHOTO = (2500, 3000)


def cost_usd(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * PRICE_PER_MTOK[0] + output_tokens * PRICE_PER_MTOK[1]) / 1e6


def estimated_cost_usd(photos: int) -> float:
    return photos * cost_usd(*EST_TOKENS_PER_PHOTO)


MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
               ".webp": "image/webp", ".gif": "image/gif"}  # fmt: skip
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # API limit per image
# The API resizes images beyond about this long edge anyway; sending more only costs upload.
MAX_EDGE = 1568

SYSTEM = f"""You inspect photos of damaged vehicles for a remarketing company and report \
exterior damage as structured findings.

Report each distinct damaged area you can see. For each one give:
- panel: one of {", ".join(p.value for p in Panel)}. Both sides of the car share a panel name \
(left and right doors are both "door"). Headlights and the grille count as front_bumper; \
taillights as rear_bumper. Use "frame" only for visible structural damage: bent rails or \
pillars, buckled floor, misaligned panel gaps from structural deformation.
- damage_type: one of {", ".join(t.value for t in DamageType)}. scratch = paint or clear-coat \
only; dent = deformed metal or plastic without tearing; crack = split or fractured part or \
glass; crush = heavy deformation that collapses the panel's shape; broken = missing, \
detached or shattered part.
- side: left or right as seen from the driver's seat, center for parts on the car's \
midline (hood, roof, windshield, bumper centers), unknown if you can't tell. The same damage \
seen in several photos should get the same panel, side and damage type.
- severity from 0 to 1 for how much of that panel's full repair the damage needs: about 0.1 \
for a small ding or scuff, 0.3 for a dent a hand could cover, 0.6 for damage over most of \
the panel, 0.9 or more when the panel needs replacing.
- confidence from 0 to 1 that this damage really exists as described. Lower it for glare, \
reflections, dirt, shadows, distance, blur or a partial view.
- box: a rectangle around the damage in this photo, as fractions of the image width and \
height (x0, y0 = top-left corner; x1, y1 = bottom-right; 0 to 1). Approximate is fine; it \
points a human checker at the spot.

Also give the photo's view: which side of the car the camera faces (front, rear, left, \
right, front_left, front_right, rear_left, rear_right, top for a view onto the roof), \
close_up for a tight shot of one area, interior, or unknown. Left and right are as seen \
from the driver's seat.

Put damage that fits no panel above (wheels, tires, mirrors, interior, underbody you can \
glimpse) in unmapped_damage as short descriptions. If the photo shows no vehicle or no \
damage, return empty lists. Describe only what is visible; don't guess about hidden damage."""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "panel": {"type": "string", "enum": [p.value for p in Panel]},
                    "damage_type": {"type": "string", "enum": [t.value for t in DamageType]},
                    "side": {"type": "string",
                             "enum": ["left", "right", "center", "unknown"]},
                    "severity": {"type": "number"},
                    "confidence": {"type": "number"},
                    "box": {
                        "type": "object",
                        "properties": {k: {"type": "number"} for k in ("x0", "y0", "x1", "y1")},
                        "required": ["x0", "y0", "x1", "y1"],
                        "additionalProperties": False,
                    },
                },
                "required": ["panel", "damage_type", "side", "severity", "confidence", "box"],
                "additionalProperties": False,
            },
        },
        "unmapped_damage": {"type": "array", "items": {"type": "string"}},
        "view": {"type": "string", "enum": list(VIEWS)},
    },
    "required": ["view", "findings", "unmapped_damage"],
    "additionalProperties": False,
}


USER_TEXT = "Report the damage in this photo."
# Changes whenever the instructions or the answer format change, so cached answers given to an
# older prompt aren't reused.
PROMPT_VERSION = hashlib.sha256(
    (SYSTEM + json.dumps(SCHEMA, sort_keys=True) + USER_TEXT).encode()
).hexdigest()[:12]
DEFAULT_CACHE_DIR = FsPath(".cache/vision")


class DetectionError(RuntimeError):
    """A photo couldn't be analyzed (missing file, refusal, unusable response)."""


def _clamp(x: float) -> float:
    return min(1.0, max(0.0, float(x)))


def _box(raw: Any) -> tuple[float, float, float, float] | None:
    """Clamped, ordered box from the answer; None when missing or empty."""
    if not isinstance(raw, dict):
        return None
    try:
        xs = sorted((_clamp(raw["x0"]), _clamp(raw["x1"])))
        ys = sorted((_clamp(raw["y0"]), _clamp(raw["y1"])))
    except (KeyError, TypeError, ValueError):
        return None
    if xs[0] == xs[1] or ys[0] == ys[1]:
        return None
    return (xs[0], ys[0], xs[1], ys[1])


def _downscale(path: FsPath) -> bytes | None:
    """JPEG bytes of the photo shrunk to MAX_EDGE on its long side and turned upright per its
    EXIF orientation, or None when it is already small and upright. Upright matters for the
    boxes: they're drawn over the photo as a browser shows it, which follows EXIF. Needs
    Pillow (vision extra)."""
    try:
        from PIL import Image, ImageOps, UnidentifiedImageError
    except ImportError:
        return None
    try:
        im = Image.open(path)
    except UnidentifiedImageError:
        return None  # not something Pillow reads; send as is and let the API judge
    with im:
        rotated = im.getexif().get(0x0112, 1) != 1  # EXIF Orientation tag
        if not rotated and max(im.size) <= MAX_EDGE and path.stat().st_size <= MAX_IMAGE_BYTES:
            return None
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((MAX_EDGE, MAX_EDGE))
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        return buf.getvalue()


def image_block(path: FsPath) -> dict[str, Any]:
    media_type = MEDIA_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise DetectionError(f"{path}: unsupported image type (use jpg, png, webp or gif)")
    data = _downscale(path) if media_type != "image/gif" else None
    if data is not None:
        media_type = "image/jpeg"
    else:
        data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise DetectionError(f"{path}: image is over 5 MB; install the vision extra "
                             "(Pillow) to downscale it automatically")  # fmt: skip
    encoded = base64.standard_b64encode(data).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                        "data": encoded}}  # fmt: skip


def parse_response(
    response: Any, photo_ref: str
) -> tuple[list[DamageFinding], list[str], str]:
    """Turn a Messages API response into (findings, unmapped-damage notes, photo view)."""
    return parse_text(response_text(response, photo_ref), photo_ref)


def response_text(response: Any, photo_ref: str) -> str:
    """The answer's JSON text, or DetectionError when the response has no usable answer."""
    if response.stop_reason == "refusal":
        raise DetectionError(f"{photo_ref}: the model declined to analyze this photo")
    if response.stop_reason == "max_tokens":
        raise DetectionError(f"{photo_ref}: response was cut off (max_tokens)")
    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise DetectionError(f"{photo_ref}: response had no text block")
    return text


def parse_text(text: str, photo_ref: str) -> tuple[list[DamageFinding], list[str], str]:
    try:
        data = json.loads(text)
        findings = [
            DamageFinding(
                panel=Panel(f["panel"]), damage_type=DamageType(f["damage_type"]),
                severity=_clamp(f["severity"]), confidence=_clamp(f["confidence"]),
                side=None if f.get("side", "unknown") == "unknown" else f["side"],
                photo_ref=photo_ref, box=_box(f.get("box")),
            )
            for f in data["findings"]
        ]  # fmt: skip
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as err:
        raise DetectionError(f"{photo_ref}: unusable response ({err})") from err
    view = data.get("view", "unknown")
    return findings, [str(x) for x in data.get("unmapped_damage", [])], (
        view if view in VIEWS else "unknown"
    )


class ClaudeVisionDetector:
    """DamageDetector backed by Claude vision.

    photo_root: directory that vehicle.photo_refs are relative to.
    client: an anthropic.Anthropic (or a stand-in with the same beta.messages.create);
    created on first use when omitted, so importing this module needs no credentials.
    cache_dir: where answers are kept, keyed by the photo's bytes, model, effort and prompt.
    A re-run then costs nothing and returns the same findings, so a confirmed review isn't
    sent back to the checker just because the model answered slightly differently. None
    turns caching off.
    """

    def __init__(
        self,
        photo_root: str | FsPath = ".",
        client: Any = None,
        model: str = MODEL,
        effort: str = "medium",
        calibration: dict[str, Any] | None = None,
        cache_dir: str | FsPath | None = None,
    ):
        self.photo_root = FsPath(photo_root)
        self._client = client
        self.model = model
        self.effort = effort
        self.calibration = calibration  # from underscope.calibration.fit, applied to confidence
        self.notes: dict[str, list[str]] = {}  # photo_ref -> unmapped damage descriptions
        self.views: dict[str, str] = {}  # photo_ref -> which side of the car the photo shows
        # photo_ref -> that photo's own findings, before merging across photos (with boxes)
        self.sightings: dict[str, list[DamageFinding]] = {}
        self.usage: list[Any] = []  # response.usage per call, for cost reporting
        self.cache_dir = FsPath(cache_dir) if cache_dir is not None else None
        self.cache_hits = 0

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                import anthropic
            except ImportError as err:
                raise DetectionError(
                    "the Claude detector needs the vision extra: pip install -e '.[vision]'"
                ) from err
            self._client = anthropic.Anthropic()
        return self._client

    # ------------------------------------------------------------ answer cache

    def _cache_path(self, photo_ref: str) -> FsPath | None:
        path = self.photo_root / photo_ref
        if self.cache_dir is None or not path.is_file():
            return None
        h = hashlib.sha256(path.read_bytes())
        h.update(f"|{self.model}|{self.effort}|{PROMPT_VERSION}".encode())
        return self.cache_dir / f"{h.hexdigest()}.json"

    def _cached(self, photo_ref: str) -> str | None:
        p = self._cache_path(photo_ref)
        return p.read_text() if p is not None and p.is_file() else None

    def _store(self, photo_ref: str, text: str) -> None:
        p = self._cache_path(photo_ref)
        if p is not None:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)

    def uncached(self, photo_refs: list[str]) -> list[str]:
        """Photos that would need an API call (cost estimates count only these)."""
        return [ref for ref in photo_refs if self._cached(ref) is None]

    def _use(self, text: str, photo_ref: str) -> list[DamageFinding]:
        findings, self.notes[photo_ref], self.views[photo_ref] = parse_text(text, photo_ref)
        self.sightings[photo_ref] = self._calibrated(findings)
        return self.sightings[photo_ref]

    def request_params(self, photo_ref: str) -> dict[str, Any]:
        """Messages API parameters for one photo (shared by live and batch requests)."""
        path = self.photo_root / photo_ref
        if not path.is_file():
            raise DetectionError(f"{photo_ref}: photo not found under {self.photo_root}")
        return {
            "model": self.model,
            "max_tokens": 16000,
            "system": SYSTEM,
            "output_config": {"effort": self.effort,
                              "format": {"type": "json_schema", "schema": SCHEMA}},
            "messages": [{"role": "user", "content": [
                image_block(path),
                {"type": "text", "text": USER_TEXT},
            ]}],
        }  # fmt: skip

    def detect_photo(self, photo_ref: str) -> list[DamageFinding]:
        cached = self._cached(photo_ref)
        if cached is not None:
            self.cache_hits += 1
            return self._use(cached, photo_ref)
        params = self.request_params(photo_ref)
        response = self.client.beta.messages.create(
            **params, betas=[FALLBACK_BETA], fallbacks="default"
        )
        self.usage.append(getattr(response, "usage", None))
        text = response_text(response, photo_ref)
        found = self._use(text, photo_ref)  # only a usable answer is cached
        self._store(photo_ref, text)
        return found

    def _calibrated(self, findings: list[DamageFinding]) -> list[DamageFinding]:
        if not self.calibration:
            return findings
        from underscope.calibration import apply

        return [f.model_copy(update={"confidence": apply(f.confidence, self.calibration)})
                for f in findings]  # fmt: skip

    def spent_usd(self, batch: bool = False) -> float:
        """Cost of the calls made so far, from the API's reported token usage. Batch requests
        are billed at half price."""
        used = [u for u in self.usage if u is not None]
        full = cost_usd(sum(u.input_tokens for u in used), sum(u.output_tokens for u in used))
        return full / 2 if batch else full

    # ------------------------------------------------------------ batches (half price, async)

    def submit_batch(self, photo_refs: list[str]) -> dict[str, Any]:
        """Submit one Message Batch for these photos. Returns state to save for collect_batch.

        Batches don't take the server-side fallback, so a declined photo comes back as a
        per-photo error instead.
        """
        ids = {f"p{i}": ref for i, ref in enumerate(photo_refs)}  # custom_id must be simple
        batch = self.client.messages.batches.create(requests=[
            {"custom_id": cid, "params": self.request_params(ref)} for cid, ref in ids.items()
        ])  # fmt: skip
        return {"batch_id": batch.id, "photos": ids, "model": self.model}

    def collect_batch(
        self, state: dict[str, Any]
    ) -> tuple[str, dict[str, list[DamageFinding]], dict[str, str]]:
        """(processing status, findings per photo, errors per photo). Findings and errors are
        empty until the status is "ended"."""
        batch = self.client.messages.batches.retrieve(state["batch_id"])
        if batch.processing_status != "ended":
            return batch.processing_status, {}, {}
        found: dict[str, list[DamageFinding]] = {}
        errors: dict[str, str] = {}
        for item in self.client.messages.batches.results(state["batch_id"]):
            ref = state["photos"].get(item.custom_id)
            if ref is None:
                continue
            if item.result.type != "succeeded":
                errors[ref] = f"{ref}: batch request {item.result.type}"
                continue
            message = item.result.message
            self.usage.append(getattr(message, "usage", None))
            try:
                text = response_text(message, ref)
                found[ref] = self._use(text, ref)
                self._store(ref, text)
            except DetectionError as err:
                errors[ref] = str(err)
        for ref in state["photos"].values():
            if ref not in found and ref not in errors:
                errors[ref] = f"{ref}: missing from batch results"
        return "ended", found, errors

    def detect(self, vehicle: VehicleRecord) -> list[DamageFinding]:
        found: list[DamageFinding] = []
        for ref in vehicle.photo_refs:
            found.extend(self.detect_photo(ref))
        # Photos overlap: the same dent seen twice must not be costed twice.
        return merge_findings(found)


# ---------------------------------------------------------------- OpenAI

OPENAI_MODEL = "gpt-5.5"
# Rough USD per million tokens (input, output) for the pre-run cost estimate only, not billing.
# Override with OPENAI_PRICE_PER_MTOK="in,out" when the real price list is known.
OPENAI_PRICE_PER_MTOK = (2.50, 15.00)


def _openai_price() -> tuple[float, float]:
    raw = os.environ.get("OPENAI_PRICE_PER_MTOK", "")
    try:
        a, b = (float(x) for x in raw.split(","))
        return (a, b)
    except ValueError:
        return OPENAI_PRICE_PER_MTOK


class _Usage:
    """OpenAI usage mapped to the input/output token names the cost report uses."""

    def __init__(self, usage: Any):
        self.input_tokens = getattr(usage, "prompt_tokens", 0) or 0
        self.output_tokens = getattr(usage, "completion_tokens", 0) or 0


class OpenAIVisionDetector(ClaudeVisionDetector):
    """DamageDetector backed by OpenAI vision (Chat Completions with a strict JSON schema).

    Same prompt, schema, answer cache, cross-photo merge and confidence calibration as the
    Claude detector; only the API call differs. The key comes from OPENAI_API_KEY (the SDK
    reads it); the model from OPENAI_MODEL, default gpt-5.5. One request per photo.
    """

    def __init__(self, photo_root: str | FsPath = ".", client: Any = None,
                 model: str | None = None, effort: str = "low",
                 calibration: dict[str, Any] | None = None,
                 cache_dir: str | FsPath | None = None):  # fmt: skip
        super().__init__(photo_root, client=client,
                         model=model or os.environ.get("OPENAI_MODEL") or OPENAI_MODEL,
                         effort=effort, calibration=calibration, cache_dir=cache_dir)  # fmt: skip

    @property
    def client(self) -> Any:
        if self._client is None:
            try:
                import openai
            except ImportError as err:
                raise DetectionError(
                    "the OpenAI detector needs the vision extra: pip install -e '.[vision]'"
                ) from err
            if not os.environ.get("OPENAI_API_KEY"):
                raise DetectionError("set OPENAI_API_KEY (in .env or the environment)")
            self._client = openai.OpenAI()
        return self._client

    def request_params(self, photo_ref: str) -> dict[str, Any]:
        path = self.photo_root / photo_ref
        if not path.is_file():
            raise DetectionError(f"{photo_ref}: photo not found under {self.photo_root}")
        src = image_block(path)["source"]  # downscaled, EXIF-upright, size-checked
        url = f"data:{src['media_type']};base64,{src['data']}"
        # Reasoning models (gpt-5.x, o-series) take reasoning_effort and reject temperature.
        sampling: dict[str, Any] = (
            {"reasoning_effort": self.effort} if re.match(r"(gpt-5|o\d)", self.model)
            else {"temperature": 0}
        )
        return {
            "model": self.model,
            **sampling,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "photo_damage", "strict": True, "schema": SCHEMA}},
            "messages": [
                {"role": "system", "content": SYSTEM + "\nReply as json matching the schema."},
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": url, "detail": "high"}},
                    {"type": "text", "text": USER_TEXT},
                ]},
            ],
        }  # fmt: skip

    def detect_photo(self, photo_ref: str) -> list[DamageFinding]:
        cached = self._cached(photo_ref)
        if cached is not None:
            self.cache_hits += 1
            return self._use(cached, photo_ref)
        response = self.client.chat.completions.create(**self.request_params(photo_ref))
        self.usage.append(_Usage(getattr(response, "usage", None)))
        choice = response.choices[0]
        if getattr(choice.message, "refusal", None):
            raise DetectionError(f"{photo_ref}: the model declined to analyze this photo")
        if choice.finish_reason == "length":
            raise DetectionError(f"{photo_ref}: response was cut off (length)")
        text = choice.message.content
        if not text:
            raise DetectionError(f"{photo_ref}: response had no content")
        found = self._use(text, photo_ref)  # only a usable answer is cached
        self._store(photo_ref, text)
        return found

    def estimate_usd(self, photos: int) -> float:
        p_in, p_out = _openai_price()
        return photos * (EST_TOKENS_PER_PHOTO[0] * p_in + EST_TOKENS_PER_PHOTO[1] * p_out) / 1e6

    def spent_usd(self, batch: bool = False) -> float:
        p_in, p_out = _openai_price()
        used = [u for u in self.usage if u is not None]
        return (sum(u.input_tokens for u in used) * p_in
                + sum(u.output_tokens for u in used) * p_out) / 1e6  # fmt: skip

    def submit_batch(self, photo_refs: list[str]) -> dict[str, Any]:
        raise DetectionError("batch mode is only built for the Claude detector; run without it")

    def collect_batch(self, state: dict[str, Any]):  # type: ignore[override]
        raise DetectionError("batch mode is only built for the Claude detector; run without it")
