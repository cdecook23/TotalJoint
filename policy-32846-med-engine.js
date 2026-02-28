/**
 * ═══════════════════════════════════════════════════════════════
 * TJR HUB — A/C/F POLICY 32846 MEDICATION CLASSIFICATION ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 * Pre-operative anesthesia medication instruction engine.
 * Classifies any medication input and returns perioperative instructions:
 *   - Drug class
 *   - Action (continue, hold, stop, must_take, per_specialist, review)
 *   - Pre-op instructions
 *   - Post-op resume instructions
 *   - Warning flags (critical stops, cardiology coordination, GLP-1 alerts)
 *
 * Based on A/C/F Policy 32846: Anesthesia Medication Instructions
 *
 * Coverage: 200+ drugs across 30+ classes
 * NSAIDs have per-drug half-life based hold days
 *
 * Usage:
 *   const result = classifyMedication("Eliquis");
 *   // { drugClass: "Anticoagulant", action: "per_specialist",
 *   //   preOp: "Per Cardiologist/Surgeon — coordinate bridging",
 *   //   postOp: "Per Cardiologist/Surgeon",
 *   //   warning: true, cardiologyCoordination: true, input: "Eliquis" }
 */

// ═══════════════════════════════════════════
// MEDICATION DATABASE
// ═══════════════════════════════════════════

const MEDICATION_DB = {};

function addMedClass(drugClass, names, rules) {
  names.forEach(name => {
    MEDICATION_DB[name.toLowerCase()] = { drugClass, ...rules };
  });
}

// ─── CARDIOVASCULAR ───

addMedClass("ACE Inhibitor", [
  "benazepril", "captopril", "enalapril", "fosinopril",
  "lisinopril", "zestril", "quinapril", "ramipril", "trandolapril"
], { action: "hold", preOp: "Hold AM/PM day of surgery", postOp: "Resume POD#1" });

addMedClass("ARB", [
  "candesartan", "irbesartan", "losartan", "cozaar",
  "olmesartan", "telmisartan", "valsartan", "diovan", "entresto"
], { action: "hold", preOp: "Hold AM/PM day of surgery", postOp: "Resume POD#1" });

addMedClass("Beta Blocker", [
  "atenolol", "tenormin", "bisoprolol", "metoprolol", "lopressor",
  "toprol", "nadolol", "nebivolol", "propranolol", "sotalol",
  "carvedilol", "coreg"
], { action: "must_take", preOp: "MUST take — cardioprotective", postOp: "Continue", warning: true });

addMedClass("Antiarrhythmic", [
  "digoxin", "amiodarone", "flecainide", "dronedarone", "dofetilide"
], { action: "must_take", preOp: "MUST take — cardioprotective", postOp: "Continue", warning: true });

addMedClass("CCB", [
  "amlodipine", "norvasc", "diltiazem", "cardizem", "nifedipine", "verapamil"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

addMedClass("Diuretic", [
  "furosemide", "lasix", "bumetanide", "spironolactone",
  "torsemide", "triamterene", "chlorthalidone", "metolazone"
], { action: "hold", preOp: "Hold day of surgery", postOp: "Resume POD#1" });

// ─── ANTICOAGULANTS & ANTIPLATELETS ───

addMedClass("Anticoagulant", [
  "apixaban", "eliquis", "rivaroxaban", "xarelto", "edoxaban",
  "warfarin", "coumadin", "enoxaparin", "lovenox", "heparin",
  "dabigatran", "pradaxa"
], {
  action: "per_specialist",
  preOp: "Per Cardiologist/Surgeon — coordinate bridging",
  postOp: "Per Cardiologist/Surgeon",
  cardiologyCoordination: true, warning: true
});

addMedClass("Antiplatelet", [
  "clopidogrel", "plavix", "prasugrel", "effient",
  "ticagrelor", "brillinta", "dipyridamole", "aggrenox"
], {
  action: "per_specialist",
  preOp: "Per Cardiologist/Surgeon",
  postOp: "Per Cardiologist/Surgeon",
  cardiologyCoordination: true, warning: true
});

addMedClass("NSAID/Antiplatelet", [
  "aspirin"
], { action: "continue", preOp: "Per surgeon", postOp: "Continue — DVT ppx" });

// ─── NSAIDs (per-drug half-life hold days) ───

const NSAID_HOLD_DAYS = {
  "diclofenac": 1, "ibuprofen": 1, "advil": 1, "motrin": 1,
  "ketorolac": 1, "etodolac": 2, "indomethacin": 2,
  "celecoxib": 2, "celebrex": 2, "meloxicam": 4, "mobic": 4,
  "naproxen": 4, "aleve": 4, "sulindac": 4,
  "nabumetone": 6, "oxaprozin": 10, "piroxicam": 10
};

Object.entries(NSAID_HOLD_DAYS).forEach(([name, days]) => {
  MEDICATION_DB[name] = {
    drugClass: "NSAID",
    action: "hold",
    preOp: `Hold ${days}d prior`,
    postOp: "Resume per surgeon",
    holdDays: days
  };
});

// ─── DIABETES ───

addMedClass("Metformin", [
  "metformin", "glucophage", "glumetza"
], { action: "hold", preOp: "Hold 12hr (48hr if CKD)", postOp: "Resume w/ oral intake + stable renal", warning: true });

addMedClass("SGLT2 Inhibitor", [
  "canagliflozin", "invokana", "dapagliflozin", "farxiga",
  "empagliflozin", "jardiance", "ertugliflozin", "steglatro"
], { action: "stop", preOp: "MUST stop 3-4d prior — DKA risk", postOp: "Resume when oral baseline", warning: true, critical: true });

addMedClass("GLP-1 RA (Daily)", [
  "liraglutide", "victoza", "saxenda"
], { action: "hold", preOp: "Hold 1 day prior", postOp: "Resume w/ oral intake", glp1: true, warning: true });

addMedClass("GLP-1 RA (Weekly)", [
  "semaglutide", "ozempic", "wegovy", "dulaglutide", "trulicity",
  "exenatide", "tirzepatide", "mounjaro", "zepbound"
], { action: "hold", preOp: "Hold min 1 week prior", postOp: "Resume w/ oral diet", glp1: true, warning: true });

addMedClass("Insulin (Rapid)", [
  "humalog", "novolog", "apidra", "humulin r"
], { action: "hold", preOp: "Hold AM DOS", postOp: "Resume w/ first meal" });

addMedClass("Insulin (Basal)", [
  "lantus", "basaglar", "toujeo", "levemir", "tresiba"
], { action: "hold", preOp: "Take 2/3 dose DOS", postOp: "Resume normal w/ diet" });

addMedClass("DPP-4 Inhibitor", [
  "sitagliptin", "januvia", "linagliptin", "tradjenta", "saxagliptin"
], { action: "hold", preOp: "Hold day of surgery", postOp: "Resume w/ oral intake" });

addMedClass("Sulfonylurea", [
  "glipizide", "glucotrol", "glyburide", "glimepiride", "amaryl"
], { action: "hold", preOp: "Hold day of surgery", postOp: "Resume w/ oral intake" });

// ─── PSYCHIATRIC / NEUROLOGICAL ───

addMedClass("MAOI", [
  "phenelzine", "nardil", "tranylcypromine", "parnate"
], { action: "stop", preOp: "MUST stop 2wk prior", postOp: "Per prescriber", warning: true, critical: true });

addMedClass("TCA", [
  "amitriptyline", "nortriptyline", "imipramine", "doxepin", "desipramine"
], { action: "hold", preOp: "OK night before. Hold AM.", postOp: "Resume w/ fluids" });

addMedClass("SSRI/SNRI", [
  "sertraline", "zoloft", "fluoxetine", "prozac", "paroxetine",
  "citalopram", "escitalopram", "lexapro", "venlafaxine",
  "duloxetine", "cymbalta", "bupropion", "wellbutrin",
  "mirtazapine", "trazodone"
], { action: "continue", preOp: "Take w/ sip water", postOp: "Continue" });

addMedClass("Opioid", [
  "oxycodone", "hydrocodone", "morphine", "tramadol",
  "methadone", "codeine", "hydromorphone", "tapentadol"
], { action: "continue", preOp: "May take DOS", postOp: "Continue" });

addMedClass("Antiseizure", [
  "gabapentin", "neurontin", "pregabalin", "lyrica",
  "levetiracetam", "keppra", "topiramate", "lamotrigine",
  "carbamazepine", "valproic acid", "lorazepam", "clonazepam"
], { action: "continue", preOp: "Take w/ sip water", postOp: "Continue" });

// ─── ENDOCRINE ───

addMedClass("Thyroid", [
  "levothyroxine", "synthroid", "armour thyroid", "methimazole", "liothyronine"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

// ─── GASTROINTESTINAL ───

addMedClass("Antireflux", [
  "omeprazole", "prilosec", "pantoprazole", "protonix",
  "lansoprazole", "esomeprazole", "nexium", "famotidine", "pepcid"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

// ─── CHOLESTEROL ───

addMedClass("Statin", [
  "atorvastatin", "lipitor", "rosuvastatin", "crestor",
  "simvastatin", "pravastatin", "lovastatin", "pitavastatin"
], { action: "continue", preOp: "Take night before", postOp: "Continue" });

addMedClass("Cholesterol (Other)", [
  "ezetimibe", "zetia", "fenofibrate", "gemfibrozil"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

// ─── IMMUNOSUPPRESSANT ───

addMedClass("Immunosuppressant", [
  "prednisone", "tacrolimus", "cyclosporine",
  "mycophenolate", "azathioprine", "sirolimus"
], { action: "continue", preOp: "Continue — critical", postOp: "Continue", warning: true });

// ─── RHEUMATOLOGIC ───

addMedClass("DMARD (Biologic)", [
  "adalimumab", "humira", "etanercept", "enbrel",
  "infliximab", "remicade", "abatacept", "orencia",
  "tofacitinib", "xeljanz", "upadacitinib", "rinvoq",
  "baricitinib", "olumiant"
], { action: "hold", preOp: "Hold per rheumatology — typically 1-2 doses before", postOp: "Per rheumatology", warning: true });

addMedClass("DMARD (Non-Biologic)", [
  "methotrexate", "hydroxychloroquine", "plaquenil",
  "sulfasalazine", "leflunomide"
], { action: "hold", preOp: "Hold per rheumatology", postOp: "Per rheumatology", warning: true });

// ─── SUPPLEMENTS & OTC ───

addMedClass("Vitamin/Supplement", [
  "calcium", "vitamin d", "vitamin d3", "vitamin c",
  "vitamin b12", "folic acid", "iron", "magnesium",
  "zinc", "multivitamin", "potassium"
], { action: "continue", preOp: "May continue", postOp: "Continue" });

addMedClass("OTC Supplement (Hold)", [
  "garlic", "ginkgo", "ginseng", "vitamin e",
  "fish oil", "omega-3", "turmeric", "saw palmetto"
], { action: "hold", preOp: "Hold DOS", postOp: "Resume post-op" });

// ─── UROLOGICAL ───

addMedClass("Urological", [
  "tamsulosin", "flomax", "alfuzosin", "dutasteride", "finasteride"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

// ─── ANTIBIOTICS ───

addMedClass("Antibiotic", [
  "cefdinir", "amoxicillin", "azithromycin", "doxycycline",
  "ciprofloxacin", "cephalexin", "clindamycin"
], { action: "continue", preOp: "Continue course", postOp: "Complete" });

// ─── WEIGHT LOSS ───

addMedClass("Weight Loss", [
  "phentermine", "qsymia"
], { action: "stop", preOp: "MUST stop 7d prior", postOp: "Per prescriber", warning: true, critical: true });

// ─── PDE-5 INHIBITORS ───

addMedClass("PDE-5 (Short-acting)", [
  "sildenafil", "viagra"
], { action: "hold", preOp: "Hold 24hr", postOp: "Per prescriber" });

addMedClass("PDE-5 (Long-acting)", [
  "tadalafil", "cialis"
], { action: "hold", preOp: "Hold 48hr", postOp: "Per prescriber" });

// ─── OSTEOPOROSIS ───

addMedClass("Bisphosphonate", [
  "alendronate", "fosamax", "risedronate", "actonel",
  "ibandronate", "boniva", "zoledronic acid", "reclast"
], { action: "continue", preOp: "Continue", postOp: "Continue" });

addMedClass("Osteoporosis (Other)", [
  "denosumab", "prolia", "teriparatide", "forteo"
], { action: "continue", preOp: "Continue", postOp: "Continue" });


// ═══════════════════════════════════════════
// CLASSIFICATION ENGINE
// ═══════════════════════════════════════════

/**
 * Classify a medication and return perioperative instructions.
 *
 * Matching strategy (in order):
 *   1. Exact match on lowercased input
 *   2. Partial match (input contains a DB key or vice versa)
 *   3. Generic name extraction from "Brand (generic)" format
 *   4. Brand name extraction from "Brand (generic)" format
 *   5. Falls back to "Unclassified" / review
 *
 * @param {string} medicationName - Brand or generic name, e.g. "Eliquis", "metformin", "Lipitor (atorvastatin)"
 * @returns {Object} Classification result
 */
function classifyMedication(medicationName) {
  const input = medicationName;
  const lower = medicationName.toLowerCase().trim();

  // 1. Exact match
  if (MEDICATION_DB[lower]) {
    return formatResult(MEDICATION_DB[lower], input);
  }

  // 2. Partial match (handles "metoprolol succinate" matching "metoprolol")
  for (const [key, value] of Object.entries(MEDICATION_DB)) {
    if (lower.includes(key) || key.includes(lower)) {
      return formatResult(value, input);
    }
  }

  // 3. Try generic name from "Brand (generic)" format
  const genericMatch = lower.match(/\(([^)]+)\)/);
  if (genericMatch) {
    const generic = genericMatch[1].trim();
    if (MEDICATION_DB[generic]) {
      return formatResult(MEDICATION_DB[generic], input);
    }
    for (const [key, value] of Object.entries(MEDICATION_DB)) {
      if (generic.includes(key) || key.includes(generic)) {
        return formatResult(value, input);
      }
    }
  }

  // 4. Try brand name (before parentheses)
  const brandMatch = lower.match(/^([^(]+)/);
  if (brandMatch) {
    const brand = brandMatch[1].trim();
    if (MEDICATION_DB[brand]) {
      return formatResult(MEDICATION_DB[brand], input);
    }
    for (const [key, value] of Object.entries(MEDICATION_DB)) {
      if (brand.includes(key) || key.includes(brand)) {
        return formatResult(value, input);
      }
    }
  }

  // 5. Unclassified
  return {
    drugClass: "Unclassified",
    action: "review",
    preOp: "Review with anesthesia",
    postOp: "Per prescriber",
    warning: false,
    critical: false,
    cardiologyCoordination: false,
    glp1: false,
    holdDays: null,
    input: input
  };
}

function formatResult(dbEntry, input) {
  return {
    drugClass: dbEntry.drugClass,
    action: dbEntry.action,
    preOp: dbEntry.preOp,
    postOp: dbEntry.postOp,
    warning: !!dbEntry.warning,
    critical: !!dbEntry.critical,
    cardiologyCoordination: !!dbEntry.cardiologyCoordination,
    glp1: !!dbEntry.glp1,
    holdDays: dbEntry.holdDays || null,
    input: input
  };
}


/**
 * Classify an array of medications and return sorted results.
 * Critical/warning items sort first, then alphabetical.
 *
 * @param {string[]} medications - Array of medication names
 * @returns {Object[]} Array of classification results, sorted by priority
 */
function classifyMedicationList(medications) {
  const results = medications.map(m => classifyMedication(m));

  // Sort: critical first, then warnings, then by action priority, then alphabetical
  const actionPriority = {
    "stop": 0, "per_specialist": 1, "must_take": 2,
    "hold": 3, "review": 4, "continue": 5
  };

  results.sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (a.warning !== b.warning) return a.warning ? -1 : 1;
    const ap = actionPriority[a.action] ?? 99;
    const bp = actionPriority[b.action] ?? 99;
    if (ap !== bp) return ap - bp;
    return a.input.localeCompare(b.input);
  });

  return results;
}


/**
 * Generate a printable pre-op medication instruction sheet.
 * Groups by action type with clear patient-facing language.
 *
 * @param {string[]} medications - Array of medication names
 * @returns {Object} Grouped instructions ready for rendering
 */
function generatePreOpInstructions(medications) {
  const classified = classifyMedicationList(medications);

  const groups = {
    critical_stop: { label: "🛑 MUST STOP BEFORE SURGERY", items: [] },
    specialist: { label: "⚠️ COORDINATE WITH SPECIALIST", items: [] },
    must_take: { label: "✅ MUST TAKE DAY OF SURGERY", items: [] },
    hold: { label: "⏸️ HOLD DAY OF SURGERY", items: [] },
    continue: { label: "💊 CONTINUE AS NORMAL", items: [] },
    review: { label: "❓ REVIEW WITH ANESTHESIA", items: [] },
  };

  classified.forEach(med => {
    if (med.critical) groups.critical_stop.items.push(med);
    else if (med.action === "per_specialist") groups.specialist.items.push(med);
    else if (med.action === "must_take") groups.must_take.items.push(med);
    else if (med.action === "hold") groups.hold.items.push(med);
    else if (med.action === "continue") groups.continue.items.push(med);
    else groups.review.items.push(med);
  });

  // Remove empty groups
  const activeGroups = Object.entries(groups)
    .filter(([_, g]) => g.items.length > 0)
    .map(([key, g]) => ({ key, ...g }));

  return {
    totalMedications: medications.length,
    classified: classified.length,
    unclassified: classified.filter(m => m.drugClass === "Unclassified").length,
    hasCriticalStops: groups.critical_stop.items.length > 0,
    hasSpecialistCoordination: groups.specialist.items.length > 0,
    groups: activeGroups
  };
}


// ═══════════════════════════════════════════
// DATABASE STATS
// ═══════════════════════════════════════════

function getDatabaseStats() {
  const classes = {};
  Object.values(MEDICATION_DB).forEach(entry => {
    classes[entry.drugClass] = (classes[entry.drugClass] || 0) + 1;
  });
  return {
    totalEntries: Object.keys(MEDICATION_DB).length,
    drugClasses: Object.keys(classes).length,
    byClass: Object.entries(classes).sort((a, b) => b[1] - a[1])
  };
}


// ═══════════════════════════════════════════
// TEST HARNESS
// ═══════════════════════════════════════════

function runTests() {
  console.log("═══ Policy 32846 Medication Engine — Test Suite ═══\n");

  // Test individual classifications
  const testCases = [
    { input: "Eliquis", expect: { drugClass: "Anticoagulant", action: "per_specialist" } },
    { input: "metformin", expect: { drugClass: "Metformin", action: "hold" } },
    { input: "Lipitor (atorvastatin)", expect: { drugClass: "Statin", action: "continue" } },
    { input: "metoprolol succinate", expect: { drugClass: "Beta Blocker", action: "must_take" } },
    { input: "Ozempic (semaglutide)", expect: { drugClass: "GLP-1 RA (Weekly)", action: "hold" } },
    { input: "Jardiance", expect: { drugClass: "SGLT2 Inhibitor", action: "stop" } },
    { input: "meloxicam", expect: { drugClass: "NSAID", action: "hold", holdDays: 4 } },
    { input: "ibuprofen", expect: { drugClass: "NSAID", action: "hold", holdDays: 1 } },
    { input: "piroxicam", expect: { drugClass: "NSAID", action: "hold", holdDays: 10 } },
    { input: "phenelzine", expect: { drugClass: "MAOI", action: "stop", critical: true } },
    { input: "SomeFakeDrug", expect: { drugClass: "Unclassified", action: "review" } },
    { input: "aspirin", expect: { drugClass: "NSAID/Antiplatelet", action: "continue" } },
    { input: "Coreg", expect: { drugClass: "Beta Blocker", action: "must_take" } },
    { input: "phentermine", expect: { drugClass: "Weight Loss", action: "stop", critical: true } },
  ];

  let passed = 0, failed = 0;
  testCases.forEach(tc => {
    const result = classifyMedication(tc.input);
    let ok = true;
    Object.entries(tc.expect).forEach(([key, val]) => {
      if (result[key] !== val) ok = false;
    });
    if (ok) { passed++; console.log(`  ✅ ${tc.input} → ${result.drugClass} / ${result.action}`); }
    else { failed++; console.log(`  ❌ ${tc.input} → expected ${JSON.stringify(tc.expect)}, got class=${result.drugClass} action=${result.action}`); }
  });

  console.log(`\n  ${passed} passed, ${failed} failed out of ${testCases.length} tests\n`);

  // Test full patient medication list
  console.log("═══ Sample Patient: Dorothy Mitchell ═══\n");
  const dorothyMeds = [
    "Eliquis (apixaban)", "Metformin (Glucophage)", "atorvastatin",
    "sertraline", "pantoprazole", "Calcium + Vitamin D",
    "meloxicam", "amlodipine", "metoprolol", "Ozempic (semaglutide)",
    "empagliflozin"
  ];

  const instructions = generatePreOpInstructions(dorothyMeds);
  console.log(`  Total: ${instructions.totalMedications} medications`);
  console.log(`  Classified: ${instructions.classified - instructions.unclassified} | Unclassified: ${instructions.unclassified}`);
  console.log(`  Critical stops: ${instructions.hasCriticalStops ? "YES ⚠️" : "No"}`);
  console.log(`  Specialist coordination: ${instructions.hasSpecialistCoordination ? "YES" : "No"}\n`);

  instructions.groups.forEach(group => {
    console.log(`  ${group.label}`);
    group.items.forEach(med => {
      console.log(`    ${med.input.padEnd(28)} ${med.preOp}`);
    });
    console.log("");
  });

  // Database stats
  const stats = getDatabaseStats();
  console.log(`═══ Database: ${stats.totalEntries} entries across ${stats.drugClasses} classes ═══\n`);
  stats.byClass.forEach(([cls, count]) => {
    console.log(`  ${cls.padEnd(25)} ${count} drugs`);
  });
}

// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

// Works in Node.js, browser, and ES modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MEDICATION_DB,
    classifyMedication,
    classifyMedicationList,
    generatePreOpInstructions,
    getDatabaseStats,
    runTests
  };
}

// Run tests if executed directly: node policy-32846-med-engine.js
if (typeof require !== "undefined" && require.main === module) {
  runTests();
}
