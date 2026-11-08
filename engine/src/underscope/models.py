"""Domain model. Money fields are integer cents."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TitleStatus(StrEnum):
    CLEAN = "clean"
    SALVAGE = "salvage"
    REBUILT = "rebuilt"


class Panel(StrEnum):
    FRONT_BUMPER = "front_bumper"
    REAR_BUMPER = "rear_bumper"
    HOOD = "hood"
    FENDER = "fender"
    DOOR = "door"
    QUARTER_PANEL = "quarter_panel"
    ROOF = "roof"
    WINDSHIELD = "windshield"
    FRAME = "frame"


class DamageType(StrEnum):
    DENT = "dent"
    SCRATCH = "scratch"
    CRACK = "crack"
    CRUSH = "crush"
    BROKEN = "broken"


class Path(StrEnum):
    REPAIR_THEN_ACV = "repair_then_acv"
    ACV_AS_IS = "acv_as_is"
    COPART_SALVAGE = "copart_salvage"
    PART_OUT = "part_out"


class VehicleRecord(BaseModel):
    vin: str
    year: int
    make: str
    model: str
    trim: str = ""
    mileage: int = Field(ge=0)
    region: str
    title_status: TitleStatus = TitleStatus.CLEAN
    photo_refs: list[str] = Field(default_factory=list)
    undercarriage_damage: bool | None = None
    engine_audio_abnormal: bool | None = None
    # True when an insurer is handling a claim (adjuster persona). Only then can repair cost
    # past the total-loss threshold trigger a title brand; a dealer's own repair does not.
    insurance_claim: bool = False
    # Optional market anchor supplied by caller (cents); real source: ACV/Copart data.
    clean_value_cents: int | None = Field(default=None, ge=0)
    # Optional sold prices of comparable damaged vehicles (cents); when given they set the
    # salvage band instead of the placeholder fraction of clean value.
    salvage_comps_cents: list[int] | None = None
    # Optional mechanical repair range (low, high) in cents, e.g. from decoded OBD-II fault
    # codes; added to the body repair estimate from the damage findings.
    mechanical_repair_cents: tuple[int, int] | None = None
    # Optional total repair estimate (low, expected, high) in cents from the caller, e.g. the
    # web app's parts table plus fault codes, already widened for what photos can't show.
    # When set it replaces the panel and mechanical estimates, and the hidden-damage reserve is
    # skipped so unseen damage isn't counted twice.
    repair_override_cents: tuple[int, int, int] | None = None
    # Optional findings supplied inline (used when no detector labels exist).
    findings: list[DamageFinding] = Field(default_factory=list)


class DamageFinding(BaseModel):
    panel: Panel
    damage_type: DamageType
    severity: float = Field(ge=0, le=1)
    confidence: float = Field(ge=0, le=1)
    photo_ref: str | None = None  # photo the finding came from, when known
    # Which side of the car, when the source can tell. Panels aren't sided in the cost model,
    # but side separates two damaged doors from one door seen in two photos.
    side: Literal["left", "right", "center"] | None = None
    verified: bool = False  # confirmed (or added) by a human checker
    # Approximate location in photo_ref as fractions of its width and height:
    # (left, top, right, bottom). For pointing the checker at the damage, not for measuring it.
    box: tuple[float, float, float, float] | None = None

    @field_validator("box")
    @classmethod
    def _box_in_photo(cls, box):
        if box is not None:
            x0, y0, x1, y1 = box
            if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
                raise ValueError("box must be (left, top, right, bottom) fractions, 0-1")
        return box


class DispositionOption(BaseModel):
    path: Path
    expected_cents: int
    p10_cents: int
    p50_cents: int
    p90_cents: int
    components: dict[str, int] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)


class Recommendation(BaseModel):
    vin: str
    winner: Path
    # Direct answer to the persona's question: dealer "does the repair pay back?",
    # adjuster "is it a total loss?".
    answer: str = ""
    options: list[DispositionOption]  # ranked best first by expected_cents
    needs_human_review: bool
    review_reasons: list[str] = Field(default_factory=list)
    total_loss_decides: bool = False
    explanation: str = ""
    flip_conditions: list[str] = Field(default_factory=list)


VehicleRecord.model_rebuild()
