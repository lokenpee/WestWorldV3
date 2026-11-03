"""Validate the 2.2 document package; this does not execute the application."""
from pathlib import Path
import json
import re
from datetime import datetime, timezone
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / "resources/v2.2"
checks = []
errors = []


def check(label, condition, detail=""):
    checks.append({"check": label, "passed": bool(condition), "detail": detail})
    if not condition:
        errors.append(label + (": " + detail if detail else ""))


def load(name):
    return json.loads((CURRENT / name).read_text(encoding="utf-8"))


# Parse all new machine resources, including nested schema definitions.
for path in sorted(CURRENT.rglob("*.json")):
    try:
        json.loads(path.read_text(encoding="utf-8"))
        check("json:" + str(path.relative_to(ROOT)), True)
    except (ValueError, UnicodeError) as exc:
        check("json:" + str(path.relative_to(ROOT)), False, str(exc))

pipeline = load("pipeline-contract.json")
data = load("data-contract.json")
operations = load("operation-catalog.json")["operations"]
triggers = load("automatic-triggers.json")["triggers"]
flows = load("data-flows.json")["flows"]
states = load("state-transitions.json")["transitions"]
cases = load("acceptance-cases.json")["cases"]
tools = load("tool-contracts.json")
results = load("tool-results.schema.json")["tools"]
models = load("model-output-contract.json")["schemas"]
examples = load("examples.json")

check("counts", (len(operations), len(triggers), len(flows), len(states), len(cases)) == (60, 17, 14, 17, 30))
check("tables", (data["globalTableCount"], data["perBookTableCount"], data["totalDefinitionCount"]) == (3, 15, 18))
check("new-tables", {t["name"] for t in data["newTables"]} == {"extractionReceipts", "assetLifecycle", "pipelineRuns"})
check("P1-serial-and-no-auto-start", pipeline["stages"]["P1"]["chaptersInFlight"] == 1 and pipeline["stages"]["P1"]["onComplete"] == "unlock-P2-and-P3-without-auto-start")
check("P2-P3-parallel", pipeline["stages"]["P2"]["canRunWith"] == ["P3"] and pipeline["stages"]["P3"]["canRunWith"] == ["P2"])
check("P3-same-session", pipeline["stages"]["P3"]["newSessionOnRecheck"] is False and pipeline["stages"]["P2"]["storySession"] is False)
check("P3-high-confidence", pipeline["stages"]["P3"]["firstPass"]["minConfidence"] == 0.85)
check("mechanical-boundary", pipeline["mechanicalPolicy"]["strictlyGreaterThan"] == 0.9 and pipeline["manualMerge"]["callsAi"] is False)
check("direct-storage-no-publish", pipeline["directStorage"]["publishAction"] is False and pipeline["directStorage"]["draftLayer"] is False and "publication" not in pipeline)
check("no-publish-operation", not {"OP-30", "OP-31"}.intersection(o["id"] for o in operations))
check("stable-current-entities", pipeline["directStorage"]["authoritativeTables"] == ["characters", "locations", "nodes", "eventLines"])
check("backup-v5", pipeline["backup"]["targetFormatVersion"] == 5 and pipeline["backup"]["excludeLeaseRecords"])

# Validate documented window examples independently of application code.
w = pipeline["stages"]["P3"]["window"]
def windows(count):
    planned = []
    start = 0
    while start < count:
        end = min(count, start + w["size"])
        planned.append([start, end])
        if end == count:
            break
        start += w["stride"]
    return planned

check("window-policy", (w["size"], w["overlap"], w["stride"]) == (100, 20, 80))
check("window-examples", windows(0) == [] and windows(100) == [[0, 100]] and windows(180) == [[0, 100], [80, 180]] and windows(240) == [[0, 100], [80, 180], [160, 240]])

check("tool-profile-counts", len(tools["profiles"]["asset_editor"]) == 10 and len(tools["profiles"]["story_editor"]) == 15 and len(results) == 16)
check("tool-name-alignment", {t["name"] for t in results} == {t["name"] for ts in tools["profiles"].values() for t in ts})
for toolname, example_key in [("query_characters", "queryCharacters"), ("query_locations", "queryLocations")]:
    declaration = next(t for t in tools["profiles"]["story_editor"] if t["name"] == toolname)
    example = examples[example_key]
    check(toolname + ":summary-whitelist", set(example["data"][0]) == set(declaration["targetRowFields"]))
    check(toolname + ":no-detail-leak", not set(example["data"][0]).intersection(declaration["excludedRowFields"]))
    check(toolname + ":stable-cursor", "after_id" in declaration["parameters"]["properties"] and "nextAfterId" in example)

runtime = load("ai-runtime-contract.json")
check("Pi-shared-model-boundary", runtime["modelBoundary"]["sharedBy"] == ["direct", "agent"] and runtime["modelBoundary"]["businessRawInferenceHttpAllowed"] is False and runtime["modelBoundary"]["settingsRawInferenceHttpAllowed"] is False)
check("Pi-mode-ownership", runtime["modes"]["direct"]["usesAgentCoreLoop"] is False and runtime["modes"]["agent"]["runtimeStateOwner"] == "pi-agent-core" and runtime["modes"]["agent"]["persistedMemoryOwner"] == "application IndexedDB")
check("Pi-read-write-count", tools["uniqueReadToolCount"] == 14 and tools["uniqueWriteToolCount"] == 2 and tools["uniqueBusinessToolCount"] == 16)
write_names = {t["name"] for ts in tools["profiles"].values() for t in ts if t["kind"] == "write"}
check("Pi-write-scope", write_names == {"commit_asset_changes", "commit_story_changes"})
check("Pi-write-before-tool-result", runtime["writePolicy"]["commitBeforeToolResult"] and runtime["writePolicy"]["atomicMemoryAndAssets"] and runtime["writePolicy"]["noWriteOnValidationFailure"])
check("Pi-finalizer-no-repeat-write", tools["finalizer"]["writesDatabase"] is False and tools["finalizer"]["schema"] == "AgentTaskSummarySchema" and "AgentTaskSummarySchema" in models)
check("Pi-app-idempotency-ledger", runtime["writePolicy"]["ledger"] == "pipelineRuns.appliedCommands" and "appliedCommands" in data["schemas"]["$defs"]["PipelineRun"]["properties"])
for name in sorted(write_names):
    schema = next(t for t in results if t["name"] == name)
    check(name + ":command-envelope", {"operationKey", "payload"}.issubset(schema["input"]["required"]) and schema["runtimeChecksReturn"])
receipt_schema = next(t for t in results if t["name"] == "commit_story_changes")["success"]
check("Pi-write-receipt-example", set(receipt_schema["required"]).issubset(examples["agentWriteReceipt"]) and examples["sameWriteRetry"]["alreadyApplied"])
branches = models["LinkEventLinesResultSchema"]["properties"]["event_line_ops"]["items"]["anyOf"]
check("strict-link-metadata", all({"confidence", "reason", "evidenceNodeIds"}.issubset(b["required"]) and b["properties"]["confidence"]["minimum"] == 0.85 for b in branches))
for key, schema_name in [("receipt", "ExtractionReceipt"), ("mergedOrigin", "AssetLifecycle")]:
    schema = data["schemas"]["$defs"][schema_name]
    check(key + ":required-properties", set(schema["required"]).issubset(examples[key]) and set(examples[key]).issubset(schema["properties"]))

# Local links in active Markdown must resolve. Historical JSON/recording contents
# are deliberately not rewritten to pretend that the application implemented 2.2.
markdown = sorted(ROOT.glob("*.md")) + sorted(CURRENT.rglob("*.md")) + [ROOT / "resources/数据值-ID与备份格式.md", ROOT / "resources/README.md", ROOT / "scripts/README.md"]
broken_links = []
table_errors = []
for path in markdown:
    content = path.read_text(encoding="utf-8")
    for target in re.findall(r"(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)", content):
        target = target.strip().strip("<>").split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            continue
        resolved = (path.parent / unquote(target)).resolve()
        # This report is produced at the end of this invocation, including a
        # clean first invocation before the generated file exists.
        generated_report = (ROOT / "evidence/v2.2-document-validation.json").resolve()
        if resolved != generated_report and not resolved.exists():
            broken_links.append(str(path.relative_to(ROOT)) + " -> " + target)
    expected = None
    in_code = False
    for line_number, line in enumerate(content.splitlines(), 1):
        if line.startswith("```"):
            in_code = not in_code
        if not in_code and line.startswith("|"):
            columns = len(re.findall(r"(?<!\\)\|", line))
            if expected is None:
                expected = columns
            elif expected != columns:
                table_errors.append(f"{path.name}:{line_number}: {columns} separators; expected {expected}")
        else:
            expected = None
    check("markdown-header:" + path.name, not re.search(r"^#\|", content, re.M))

check("local-links", not broken_links, "; ".join(broken_links))
check("markdown-tables", not table_errors, "; ".join(table_errors))
opdoc = (ROOT / "09-操作与自动触发契约.md").read_text(encoding="utf-8")
check("operation-doc-machine-alignment", all(f"## {o['id']} · {o['label']}" in opdoc and o["steps"].replace("|", "／") in opdoc for o in operations))
check("target-verification-honest", all(c["applicationVerification"] == "not-run-target-not-implemented" for c in cases) and pipeline["legacy"]["newWorkflowVerified"] is False)

report = {
    "documentVersion": "2.2",
    "validatedAt": datetime.now(timezone.utc).isoformat(),
    "kind": "documentation-only",
    "applicationTestsRun": False,
    "checks": checks,
    "passed": len(checks) - len(errors),
    "failed": len(errors),
    "limitations": ["No application workflow execution", "Schema example checks cover required keys, not full JSON Schema semantics", "No real model, browser concurrency, or UI rendering verification"],
}
(ROOT / "evidence/v2.2-document-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"passed": report["passed"], "failed": report["failed"], "errors": errors}, ensure_ascii=False, indent=2))
raise SystemExit(1 if errors else 0)
