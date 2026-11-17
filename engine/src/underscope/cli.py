"""Command line interface: route assessments, train the router model, export the contracts."""

from __future__ import annotations

import json
from pathlib import Path as FsPath
from typing import Annotated

import typer

app = typer.Typer(add_completion=False, no_args_is_help=True,
                  help="UnderScope routing engine: ACV or Copart for a damaged vehicle.")


@app.callback()
def main() -> None:
    """UnderScope routing engine."""


@app.command("contracts")
def contracts_cmd(
    check: Annotated[
        bool, typer.Option("--check", help="Only check the files match the code (exit 1 if not).")
    ] = False,
) -> None:
    """Write the JSON Schemas for every file passed between stages to contracts/."""
    from underscope import contracts

    if check:
        drift = contracts.stale()
        if drift:
            typer.echo(f"Out of date: {', '.join(drift)}. Run: underscope contracts")
            raise typer.Exit(1)
        typer.echo("Contracts match the code.")
        return
    for path in contracts.write():
        typer.echo(f"Wrote {path}")


@app.command("route-assessment")
def route_assessment_cmd(
    path: Annotated[FsPath, typer.Argument(help="One Assessment (.json), or one per line "
                                                "(.jsonl; a bare Assessment or {id, kind, a}).")],
) -> None:
    """Route the reader's Assessment(s) to ACV or Copart and print the routing JSON."""
    from underscope.bridge import route

    text = path.read_text(encoding="utf-8")
    if path.suffix != ".jsonl":
        typer.echo(json.dumps(route(json.loads(text)), indent=2))
        return
    for line in filter(str.strip, text.splitlines()):
        row = json.loads(line)
        wrapped = isinstance(row.get("a"), dict)
        out = route(row["a"] if wrapped else row)
        typer.echo(json.dumps({"id": row.get("id"), **out} if wrapped else out))


@app.command("train-router")
def train_router_cmd(
    data: Annotated[
        FsPath | None,
        typer.Option(help="Training rows (.jsonl of {assessment, outcome}; see "
                          "contracts/router-training-row.schema.json). Without it, made-up "
                          "cars labelled by the dollar simulation."),
    ] = None,
    n: Annotated[int, typer.Option(help="Made-up cars to generate when --data is not given.")]
    = 20000,
    seed: Annotated[int, typer.Option(help="Seed for the made-up cars and the model.")] = 7,
) -> None:
    """Train the ACV-or-Copart model, save it and write the held-out report."""
    from underscope import router

    rows = router.read_rows(data) if data else router.simulated_rows(n, seed)
    model = router.train(rows, seed)
    model.meta["reader_fixture"] = router.fixture_check(model)
    model.meta["deployed"] = router.policy_check(model)
    router.save(model)
    router.REPORT_PATH.write_text(router.report(model.meta))
    h = model.meta["held_out"]
    typer.echo(f"Trained on {model.meta['rows']:,} cars ({model.meta['trained_on']}); on "
               f"{h['rows']:,} held out it picks the better marketplace {h['agreement']:.1%} of "
               "the time.")
    typer.echo(f"Wrote {router.MODEL_PATH}, {router.META_PATH} and {router.REPORT_PATH}.")


@app.command("router-check")
def router_check_cmd(
    n: Annotated[int, typer.Option(help="Fresh made-up cars to route.")] = 3000,
    seed: Annotated[int, typer.Option(help="Seed for those cars (not the training seed).")] = 1007,
) -> None:
    """Measure the engine as it answers (simulation or model) on fresh made-up cars and store
    the result with the model. Run after changing who decides, without retraining."""
    from underscope import router

    model = router.load_model()
    if model is None:
        raise typer.BadParameter("no model file: run `underscope train-router` first")
    model.meta["deployed"] = d = router.policy_check(model, n, seed)
    router.save(model)
    router.REPORT_PATH.write_text(router.report(model.meta))
    typer.echo(f"On {d['rows']:,} fresh cars the engine names the full-information marketplace "
               f"{d['agreement']:.1%} of the time. Wrote {router.META_PATH} and "
               f"{router.REPORT_PATH}.")


@app.command("reader-rates")
def reader_rates_cmd(
    fixture: Annotated[
        FsPath | None,
        typer.Option(help="The reader's fixture ({id, kind, a} lines). Default: "
                          "tests/fixtures/reader_assessments.jsonl."),
    ] = None,
) -> None:
    """Measure how often the reader's output gives each fact and save the rates the training
    cars are hidden with (config/reader_given_rates.json). Retrain afterwards."""
    from underscope import router

    rates = router.given_rates(fixture or router.FIXTURE_PATH)
    router.RATES_PATH.write_text(json.dumps(rates, indent=2) + "\n")
    router.load_rates.cache_clear()
    typer.echo(f"Wrote {router.RATES_PATH} from "
               + ", ".join(f"{v['rows']} {k} rows" for k, v in rates["profiles"].items()) + ".")


@app.command("router-data")
def router_data_cmd(
    out: Annotated[FsPath, typer.Option(help="Where to write the .jsonl file.")],
    n: Annotated[int, typer.Option(help="Made-up cars to generate.")] = 1000,
    seed: Annotated[int, typer.Option(help="Seed.")] = 7,
) -> None:
    """Write made-up cars labelled by the dollar simulation, in the training-row format
    (the template for a file of recorded outcomes)."""
    from underscope import router

    rows = router.simulated_rows(n, seed)
    out.write_text("".join(r.model_dump_json() + "\n" for r in rows), encoding="utf-8")
    typer.echo(f"Wrote {len(rows):,} simulated rows to {out}.")
