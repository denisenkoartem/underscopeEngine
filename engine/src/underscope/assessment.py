"""The reader's JSON for one seller description: the engine's input from the web app.

A mirror of reader/src/contract.ts (`Assessment`): same keys, same values. The reader extracts
and decides nothing; the engine decides from this. Everything is optional. What the description
does not say is "unknown", null or an empty list, and a value the engine does not know is read
as "unknown" rather than rejected, so a newer reader never breaks the engine.
tests/test_assessment.py checks these lists against contract.ts.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from underscope.models import Condition

PARTS = (
    "front_bumper", "hood", "grille", "left_headlight", "right_headlight", "windshield",
    "left_front_fender", "right_front_fender", "left_front_door", "right_front_door",
    "left_rear_door", "right_rear_door", "left_mirror", "right_mirror", "left_rear_quarter",
    "right_rear_quarter", "tailgate_or_rear_doors", "rear_bumper", "left_taillight",
    "right_taillight", "wheels_and_tires", "roof", "interior", "engine_bay", "underbody",
)  # fmt: skip
GRADES = ("fine", "repairable", "replace")
DAMAGE_AREAS = ("front", "rear", "side", "rollover", "all_over", "undercarriage", "mechanical",
                "hail", "water", "fire", "vandalism", "theft", "minor", "none")  # fmt: skip
# Fields with a fixed list of values; "unknown" is always allowed on top.
ENUMS: dict[str, tuple[str, ...]] = {
    "title_status": ("clean", "salvage", "rebuilt", "flood", "non_repairable", "lemon"),
    "lien": ("none", "open"),
    "odometer_status": ("actual", "not_actual", "exempt"),
    "seller_type": ("dealer", "insurer", "fleet", "lender", "individual"),
    "run_status": ("runs_and_drives", "starts", "does_not_start"),
    "engine_condition": ("ok", "minor", "failed"),
    "transmission_condition": ("ok", "minor", "failed"),
    "drivetrain": ("fwd", "rwd", "awd", "4wd"),
    "fuel_type": ("gas", "diesel", "hybrid", "electric"),
    "primary_damage": DAMAGE_AREAS,
    "secondary_damage": DAMAGE_AREAS,
    "catalytic_converter": ("present", "missing"),
    "already_repaired": ("yes", "partly", "no"),
}
TRI_FIELDS = ("title_in_hand", "keys", "parts_missing")  # true / false / "unknown"
FLAGS = ("airbags_deployed", "frame_suspected", "fluid_leak", "flood_suspected", "fire_damage")
VALUE_FIELDS = ("clean_wholesale", "purchase_price", "repair_estimate", "reserve_price")
LANES = ("acv", "copart")

# The keys that carry a Condition fact. A body with none of them (the page before the reader
# sent the full Assessment) gets no condition at all, so its numbers do not change.
CONDITION_KEYS = ("run_status", "keys", "engine_condition", "transmission_condition",
                  "catalytic_converter", "odometer_status", "title_in_hand", "lien")  # fmt: skip
CONDITION_FLAGS = ("flood_suspected", "fire_damage")


def _tri(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


class Assessment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reader: str | None = None
    vin: str | None = None
    vehicle: dict[str, Any] = Field(default_factory=dict)

    title_status: str = "unknown"
    title_state: str | None = None
    title_in_hand: bool | str = "unknown"
    lien: str = "unknown"

    mileage: float | None = None
    odometer_status: str = "unknown"
    region: str | None = None
    zip: str | None = None
    seller_type: str = "unknown"
    lanes_allowed: list[str] | None = None

    run_status: str = "unknown"
    keys: bool | str = "unknown"
    engine_condition: str = "unknown"
    transmission_condition: str = "unknown"
    drivetrain: str = "unknown"
    fuel_type: str = "unknown"

    primary_damage: str = "unknown"
    secondary_damage: str = "unknown"
    grades: list[dict[str, Any]] = Field(default_factory=list)
    flags: dict[str, Any] = Field(default_factory=dict)
    catalytic_converter: str = "unknown"
    parts_missing: bool | str = "unknown"
    already_repaired: str = "unknown"

    warning_lights: list[str] = Field(default_factory=list)
    codes: list[Any] = Field(default_factory=list)
    symptoms: list[dict[str, Any]] = Field(default_factory=list)

    values: dict[str, Any] = Field(default_factory=dict)
    storage_cost_per_day: float | None = None
    sell_by_days: float | None = None

    evidence: dict[str, Any] = Field(default_factory=dict)
    missing: list[str] = Field(default_factory=list)
    could_add: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    additional: list[str] = Field(default_factory=list)
    conflicts: list[dict[str, Any]] = Field(default_factory=list)

    # The page adds its repair estimate from /api/decide: {low, high, expected?} in dollars.
    repair: dict[str, Any] | None = None

    @field_validator(*ENUMS, mode="before")
    @classmethod
    def _known_value(cls, v: Any, info) -> str:
        return v if v in ENUMS[info.field_name] else "unknown"

    @field_validator(*TRI_FIELDS, mode="before")
    @classmethod
    def _yes_no_unknown(cls, v: Any) -> bool | str:
        return v if isinstance(v, bool) else "unknown"

    @field_validator("lanes_allowed", mode="before")
    @classmethod
    def _known_lanes(cls, v: Any) -> list[str] | None:
        lanes = [x for x in v if x in LANES] if isinstance(v, list) else []
        return lanes or None  # an empty or unreadable limit is no limit

    @field_validator("vehicle", "flags", "values", "evidence", mode="before")
    @classmethod
    def _object(cls, v: Any) -> dict:
        return v if isinstance(v, dict) else {}

    @field_validator("grades", "warning_lights", "codes", "symptoms", "missing", "could_add",
                     "questions", "additional", "conflicts", mode="before")  # fmt: skip
    @classmethod
    def _list(cls, v: Any) -> list:
        return v if isinstance(v, list) else []

    def condition(self) -> Condition | None:
        """The facts the money uses, or None when the body carries none of their keys."""
        sent = self.model_fields_set
        if not sent & set(CONDITION_KEYS) and not set(self.flags) & set(CONDITION_FLAGS):
            return None

        def known(field: str) -> str | None:
            v = getattr(self, field)
            return None if v == "unknown" else v

        return Condition(
            run_status=known("run_status"),
            keys=_tri(self.keys),
            engine=known("engine_condition"),
            transmission=known("transmission_condition"),
            flood_suspected=_tri(self.flags.get("flood_suspected")),
            fire_damage=_tri(self.flags.get("fire_damage")),
            airbags_deployed=_tri(self.flags.get("airbags_deployed")),
            catalytic_converter=known("catalytic_converter"),
            odometer_status=known("odometer_status"),
            title_in_hand=_tri(self.title_in_hand),
            lien=known("lien"),
        )
