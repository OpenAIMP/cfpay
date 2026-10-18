/* A2A Endpoint Tester (issue #258).
 *
 * Classic script (no modules, no bundler): appends an "A2A Endpoint
 * Tester" card to the dashboard QA panel. The agent list comes from the
 * public fleet index; each agent's operations come from its own card
 * (the `operations` array generated from src/a2a-ops.ts), so the form
 * renders exactly the inputs the selected operation declares. Run
 * dispatches a REAL call to that agent's A2A endpoint through
 * POST /api/dashboard/a2a/dispatch (dashboard-key authenticated).
 *
 * All user and agent output is rendered via textContent - never
 * innerHTML - because operation replies are agent-generated and
 * untrusted.
 */
(function () {
  "use strict";

  function el(tag, text, attrs) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
      }
    }
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function inputControl(input, valueHolder) {
    var hint = input.hint || "";
    if (input.type === "boolean") {
      var cb = el("input", null, { type: "checkbox", id: "a2a-in-" + input.name });
      valueHolder.push(function (params) {
        params[input.name] = cb.checked;
      });
      return cb;
    }
    if (input.type === "number") {
      var num = el("input", null, { type: "number", id: "a2a-in-" + input.name, placeholder: hint });
      valueHolder.push(function (params, errors) {
        var v = num.value.trim();
        if (!v) {
          if (input.required) errors.push(input.name + " is required");
          return;
        }
        var n = Number(v);
        if (!isFinite(n)) {
          errors.push(input.name + " must be a number");
          return;
        }
        params[input.name] = n;
      });
      return num;
    }
    if (input.type === "json") {
      var ta = el("textarea", null, {
        id: "a2a-in-" + input.name,
        placeholder: hint,
        rows: "3",
        style: "font-family:monospace;font-size:0.8rem;",
      });
      valueHolder.push(function (params, errors) {
        var v = ta.value.trim();
        if (!v) {
          if (input.required) errors.push(input.name + " is required");
          return;
        }
        try {
          params[input.name] = JSON.parse(v);
        } catch (e) {
          errors.push(input.name + " is not valid JSON");
        }
      });
      return ta;
    }
    var text = el("input", null, { type: "text", id: "a2a-in-" + input.name, placeholder: hint });
    valueHolder.push(function (params, errors) {
      var v = text.value.trim();
      if (!v) {
        if (input.required) errors.push(input.name + " is required");
        return;
      }
      params[input.name] = v;
    });
    return text;
  }

  function buildTester(qaPanel) {
    var card = el("div", null, { class: "card" });
    card.appendChild(el("h3", "A2A Endpoint Tester", { style: "margin-bottom:1rem;" }));
    var intro = el("p", "Dispatch a real call to any agent's A2A endpoint. Inputs are rendered from the operation declarations on each agent's own card.", {
      style: "color:var(--muted);font-size:0.8rem;margin-bottom:1rem;",
    });
    card.appendChild(intro);

    var agentRow = el("div", null, { class: "form-group" });
    agentRow.appendChild(el("label", "Agent"));
    var agentSel = el("select", null, { id: "a2a-agent" });
    agentRow.appendChild(agentSel);

    var opRow = el("div", null, { class: "form-group" });
    opRow.appendChild(el("label", "Operation"));
    var opSel = el("select", null, { id: "a2a-op" });
    opRow.appendChild(opSel);

    var opMeta = el("div", null, { style: "margin-bottom:1rem;" });
    var inputsBox = el("div", null, { id: "a2a-inputs" });
    var runRow = el("div", null, { class: "form-group" });
    var runBtn = el("button", "Run", { class: "btn", id: "a2a-run", type: "button" });
    runRow.appendChild(runBtn);
    var result = el("div", null, { id: "a2a-result", style: "margin-top:1rem;" });

    card.appendChild(agentRow);
    card.appendChild(opRow);
    card.appendChild(opMeta);
    card.appendChild(inputsBox);
    card.appendChild(runRow);
    card.appendChild(result);
    qaPanel.appendChild(card);

    var fleet = [];
    var cards = {};
    var currentOps = [];
    var currentKey = "";

    function renderOps(ops) {
      clear(opSel);
      currentOps = Array.isArray(ops) ? ops : [];
      currentOps.forEach(function (op, i) {
        var o = el("option", op.operation + (op.access !== "read" ? " [" + op.access + "]" : ""), { value: String(i) });
        opSel.appendChild(o);
      });
      renderOp();
    }

    function renderOp() {
      clear(opMeta);
      clear(inputsBox);
      clear(result);
      var op = currentOps[Number(opSel.value) || 0];
      if (!op) return;
      var meta = el("div", null, { style: "font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;" });
      meta.appendChild(el("span", op.summary || ""));
      var badge = el("span", op.access || "read", {
        style:
          "display:inline-block;margin-left:0.5rem;padding:0.1rem 0.5rem;border-radius:999px;font-size:0.7rem;font-weight:600;" +
          (op.access === "write"
            ? "background:rgba(255,90,90,0.15);color:#ff8a8a;"
            : op.access === "action"
              ? "background:rgba(255,180,80,0.15);color:#ffcf7a;"
              : "background:rgba(90,200,120,0.15);color:#7ad99a;"),
      });
      meta.appendChild(badge);
      opMeta.appendChild(meta);
      if (op.access === "write" || op.access === "action") {
        opMeta.appendChild(
          el("div", "This operation really acts (" + op.access + " class): it will post, send, create, or run real work.", {
            style: "font-size:0.75rem;color:#ffcf7a;margin-bottom:0.5rem;",
          })
        );
      }

      var collectors = [];
      (op.inputs || []).forEach(function (input) {
        var row = el("div", null, { class: "form-group" });
        var label = el("label", input.name + (input.required ? " *" : ""), { for: "a2a-in-" + input.name });
        if (input.hint) label.title = input.hint;
        row.appendChild(label);
        row.appendChild(inputControl(input, collectors));
        if (input.hint && input.type !== "json" && input.type !== "number") {
          row.appendChild(el("div", input.hint, { style: "font-size:0.7rem;color:var(--muted);" }));
        }
        inputsBox.appendChild(row);
      });
      if (!(op.inputs || []).length) {
        inputsBox.appendChild(el("div", "No inputs required.", { style: "font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;" }));
      }
      inputsBox._collectors = collectors;
    }

    function showError(msg) {
      clear(result);
      result.appendChild(el("div", msg, { class: "status-msg error" }));
    }

    runBtn.addEventListener("click", function () {
      var op = currentOps[Number(opSel.value) || 0];
      if (!op) {
        showError("Pick an operation first.");
        return;
      }
      var params = {};
      var errors = [];
      (inputsBox._collectors || []).forEach(function (collect) {
        collect(params, errors);
      });
      if (errors.length) {
        showError(errors.join("; "));
        return;
      }
      clear(result);
      result.appendChild(el("div", "Running…", { class: "loading" }));
      var body = { surface: currentKey, operation: op.operation, params: params };
      if (typeof api !== "function") {
        showError("Dashboard api() helper is not available.");
        return;
      }
      api("/api/dashboard/a2a/dispatch", "POST", body).then(function (res) {
        clear(result);
        if (!res || !res.ok) {
          var msg = (res && (res.error || res.detail)) || "Dispatch failed.";
          var code = res && res.code ? " (" + res.code + ")" : "";
          showError(msg + code);
          return;
        }
        result.appendChild(el("div", "ok", { class: "status-msg success" }));
        if (res.text) {
          var pre = el("div", null, { style: "margin:0.5rem 0;white-space:pre-wrap;font-size:0.85rem;" });
          pre.textContent = res.text;
          result.appendChild(pre);
        }
        if (res.data !== null && res.data !== undefined) {
          var jsonPre = el("pre", null, { style: "font-size:0.75rem;overflow-x:auto;background:var(--bg-subtle,#161e2e);padding:0.5rem;border-radius:4px;" });
          jsonPre.textContent = JSON.stringify(res.data, null, 2);
          result.appendChild(jsonPre);
        }
      });
    });

    opSel.addEventListener("change", renderOp);

    agentSel.addEventListener("change", function () {
      var entry = fleet[Number(agentSel.value) || 0];
      if (!entry) return;
      currentKey = entry.agent;
      clear(opSel);
      clear(inputsBox);
      clear(opMeta);
      clear(result);
      inputsBox.appendChild(el("div", "Loading operations…", { class: "loading" }));
      var cached = cards[currentKey];
      var apply = function (card) {
        cards[currentKey] = card;
        clear(inputsBox);
        var ops = card && card.operations;
        if (!Array.isArray(ops) || !ops.length) {
          showError("This agent's card declares no operations.");
          return;
        }
        renderOps(ops);
      };
      if (cached) {
        apply(cached);
      } else {
        fetchJson(entry.cardUrl).then(apply, function (e) {
          showError("Could not load the agent card: " + e.message);
        });
      }
    });

    fetchJson("/.well-known/agent-cards.json").then(
      function (index) {
        fleet = (index && index.agents) || [];
        clear(agentSel);
        if (!fleet.length) {
          agentSel.appendChild(el("option", "No agents found", { value: "-1" }));
          return;
        }
        fleet.forEach(function (entry, i) {
          agentSel.appendChild(el("option", entry.name + " (" + entry.agent + ")", { value: String(i) }));
        });
        agentSel.dispatchEvent(new Event("change"));
      },
      function (e) {
        clear(result);
        showError("Could not load the fleet index: " + e.message);
      }
    );
  }

  document.addEventListener("DOMContentLoaded", function () {
    var qa = document.getElementById("qa");
    if (!qa) return;
    if (document.getElementById("a2a-run")) return; // already built
    buildTester(qa);
  });
})();
