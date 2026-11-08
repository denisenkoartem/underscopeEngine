// Builds the underscope confirm command from the review sheet form. Sends nothing.
(() => {
  const data = JSON.parse(document.getElementById("fix-data").textContent);
  const $ = (id) => document.getElementById(id);
  const added = [];
  const q = (s) => /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
  function build() {
    const parts = ["underscope", "confirm", q(data.json), "--checker", q($("checker").value.trim() || "NAME")];
    for (const f of data.findings) {
      if ($("rm-" + f.n).checked) { parts.push("--remove", String(f.n)); continue; }
      const v = parseFloat($("sev-" + f.n).value);
      if (!Number.isNaN(v) && Math.abs(v - f.severity) > 1e-9) parts.push("--severity", f.n + ":" + v);
    }
    for (const a of added) parts.push("--add", [a.panel, a.type, a.severity].concat(a.side ? [a.side] : []).join(":"));
    if ($("uc").value) parts.push("--undercarriage", $("uc").value);
    if ($("eng").value) parts.push("--engine-audio", $("eng").value);
    $("cmd").textContent = parts.join(" ");
  }
  function listAdded() {
    const ul = $("added");
    ul.replaceChildren(...added.map((a, i) => {
      const li = document.createElement("li");
      li.textContent = (a.side ? a.side + " " : "") + a.panel + " " + a.type + " " + a.severity + " ";
      const b = document.createElement("button");
      b.type = "button"; b.textContent = "Undo";
      b.addEventListener("click", () => { added.splice(i, 1); listAdded(); build(); });
      li.append(b);
      return li;
    }));
  }
  $("add-btn").addEventListener("click", () => {
    const sev = parseFloat($("add-sev").value);
    if (Number.isNaN(sev) || sev < 0 || sev > 1) { $("add-msg").textContent = "Severity must be from 0 to 1."; return; }
    $("add-msg").textContent = "";
    added.push({panel: $("add-panel").value, type: $("add-type").value, severity: sev, side: $("add-side").value});
    listAdded(); build();
  });
  document.getElementById("fix").addEventListener("input", build);
  document.getElementById("fix").addEventListener("submit", (ev) => ev.preventDefault());
  $("copy").addEventListener("click", () => {
    const done = () => { $("copied").textContent = "Copied"; };
    const select = () => {
      const r = document.createRange(); r.selectNodeContents($("cmd"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      $("copied").textContent = "Selected; press Ctrl+C";
    };
    if (navigator.clipboard) navigator.clipboard.writeText($("cmd").textContent).then(done, select);
    else select();
  });
  build();
})();
