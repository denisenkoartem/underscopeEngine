# Sensitivity to PLACEHOLDER assumptions

Each row scales one placeholder (every number in it) and re-runs the fixture. Cells
show the recommended path; **bold** marks a change from the 1x result. A row that
changes means the recommendation depends on that unknown and real data should come
first for it. Fixtures and values are synthetic.

## dent_600.json

| Placeholder | 0.5x | 0.75x | 1x | 1.25x | 1.5x |
|---|---|---|---|---|---|
| `market.as_is_discount_multiple_of_repair` | as-is | as-is | as-is | as-is | as-is |
| `market.repaired_value_haircut_pct_at_total_damage` | as-is | as-is | as-is | as-is | as-is |
| `market.salvage_fraction_of_clean` | as-is | as-is | as-is | as-is | as-is |
| `timing.holding_cost_per_day_cents` | as-is | as-is | as-is | as-is | as-is |
| `hidden_damage.reserve_pct_of_repair` | as-is | as-is | as-is | as-is | as-is |
| `parts.gross_value_fraction_of_clean` | as-is | as-is | as-is | as-is | as-is |
| `parts.sell_through` | as-is | as-is | as-is | as-is | as-is |
| `fees.acv` | as-is | as-is | as-is | as-is | as-is |
| `fees.copart` | as-is | as-is | as-is | as-is | as-is |

Break-even: repair wins once buyers discount the as-is car by **2.44x** the repair cost (placeholder: 1.3x).

## borderline_writeoff.json

| Placeholder | 0.5x | 0.75x | 1x | 1.25x | 1.5x |
|---|---|---|---|---|---|
| `market.as_is_discount_multiple_of_repair` | **as-is** | parts | parts | parts | parts |
| `market.repaired_value_haircut_pct_at_total_damage` | parts | parts | parts | parts | parts |
| `market.salvage_fraction_of_clean` | parts | parts | parts | parts | parts |
| `timing.holding_cost_per_day_cents` | parts | parts | parts | parts | parts |
| `hidden_damage.reserve_pct_of_repair` | parts | parts | parts | parts | parts |
| `parts.gross_value_fraction_of_clean` | **as-is** | parts | parts | parts | parts |
| `parts.sell_through` | **as-is** | parts | parts | parts | parts |
| `fees.acv` | parts | parts | parts | parts | parts |
| `fees.copart` | parts | parts | parts | parts | parts |

Break-even: repair does not win at any as-is discount multiple up to 6x.

## total_loss.json

| Placeholder | 0.5x | 0.75x | 1x | 1.25x | 1.5x |
|---|---|---|---|---|---|
| `market.as_is_discount_multiple_of_repair` | parts | parts | parts | parts | parts |
| `market.repaired_value_haircut_pct_at_total_damage` | parts | parts | parts | parts | parts |
| `market.salvage_fraction_of_clean` | parts | parts | parts | parts | parts |
| `timing.holding_cost_per_day_cents` | parts | parts | parts | parts | parts |
| `hidden_damage.reserve_pct_of_repair` | parts | parts | parts | parts | parts |
| `parts.gross_value_fraction_of_clean` | **as-is** | parts | parts | parts | parts |
| `parts.sell_through` | **as-is** | parts | parts | parts | parts |
| `fees.acv` | parts | parts | parts | parts | parts |
| `fees.copart` | parts | parts | parts | parts | parts |

Break-even: repair does not win at any as-is discount multiple up to 6x.

Regenerate with `.venv/bin/python -m underscope.sensitivity`.
