"""Runs the review sheet's command builder under Node with a stub page (skipped without Node)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from underscope import review
from underscope.models import DamageFinding, VehicleRecord

NODE = shutil.which("node")
JS = Path(review.__file__).with_name("review_confirm.js")

HARNESS = r"""
const els = {};
const el = (id) => els[id] ||= {
  id, value: "", checked: false, textContent: "", listeners: {},
  addEventListener(t, f) { this.listeners[t] = f; }, replaceChildren() {}, append() {},
};
const state = JSON.parse(process.argv[1]);
globalThis.document = {
  getElementById: (id) => id === "fix-data" ? { textContent: state.data } : el(id),
  createElement: () => el("tmp" + Math.random()),
  createRange: () => ({ selectNodeContents() {} }),
};
globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
for (const [id, v] of Object.entries(state.values)) Object.assign(el(id), v);
require(process.argv[2]);
for (const add of state.adds) {
  Object.assign(el("add-panel"), {value: add[0]}); Object.assign(el("add-type"), {value: add[1]});
  Object.assign(el("add-sev"), {value: add[2]}); Object.assign(el("add-side"), {value: add[3]});
  el("add-btn").listeners.click();
}
el("fix").listeners.input();
console.log(el("cmd").textContent);
"""


def run(values, adds=()):
    req = review.build_request(
        VehicleRecord(vin="V1", year=2021, make="X", model="Y", mileage=1, region="NY"),
        [DamageFinding(panel="door", damage_type="dent", severity=0.4, confidence=0.9),
         DamageFinding(panel="hood", damage_type="scratch", severity=0.1, confidence=0.5)],
    )  # fmt: skip
    page = review.render_html(req, json_ref="reviews/V1.json")
    data = page.split('id="fix-data">', 1)[1].split("</script>", 1)[0]
    state = json.dumps({"data": data, "values": values, "adds": list(adds)})
    out = subprocess.run([NODE, "-e", HARNESS, state, str(JS)], capture_output=True,
                         text=True, check=True)  # fmt: skip
    return out.stdout.strip()


pytestmark = pytest.mark.skipif(NODE is None, reason="needs node")


def test_untouched_form_confirms_as_is():
    assert run({}) == "underscope confirm reviews/V1.json --checker NAME"


def test_corrections_become_flags_and_names_are_shell_quoted():
    cmd = run({"checker": {"value": "Pat O'Neil"}, "sev-1": {"value": "0.6"},
               "sev-2": {"value": "0.1"}, "rm-2": {"checked": True}, "uc": {"value": "yes"}},
              adds=[("frame", "crush", "0.7", ""), ("fender", "dent", "0.3", "left")])  # fmt: skip
    assert cmd == ("underscope confirm reviews/V1.json --checker 'Pat O'\\''Neil' "
                   "--severity 1:0.6 --remove 2 --add frame:crush:0.7 "
                   "--add fender:dent:0.3:left --undercarriage yes")  # fmt: skip
