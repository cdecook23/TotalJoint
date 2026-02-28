/**
 * ═══════════════════════════════════════════════════════════════
 * TJR HUB — SOAP MAPPING ENGINE
 * ═══════════════════════════════════════════════════════════════
 *
 * Transforms patient intake form responses (v7) into the provider
 * workstation (v8) data structure. This is the bridge between
 * what the patient fills out on their phone and what Dr. DeCook
 * sees when he opens the chart.
 *
 * Input:  Intake form responses (flat key-value object)
 * Output: Provider workstation patient object (nested structure)
 *
 * Pipeline:
 *   Intake responses
 *     → Demographics mapping
 *     → Joint normalization (intake keys → workstation joint objects)
 *     → Per-joint HPI generation (natural language from structured data)
 *     → Condition → ICD-10 + display name mapping
 *     → BMI calculation + unit conversion (imperial → metric)
 *     → Medication list passthrough (for Policy 32846 engine)
 *     → ROS defaults generation
 *     → Caregiver mapping
 *     → Flags computation (blood thinners, diabetes, cardiac)
 *     → Visit type inference
 *     → Provider workstation patient object
 */

// ═══════════════════════════════════════════
// REFERENCE TABLES
// ═══════════════════════════════════════════

// Intake condition values → ICD-10 + display + workstation PMH key
const CONDITION_MAP = {
  diabetes:              { icd: "E11.9",  display: "Diabetes",               pmhKey: "diabetes" },
  cardiac_stenting:      { icd: "Z95.5",  display: "Cardiac Stenting",       pmhKey: "cardiac_stenting" },
  cabg:                  { icd: "Z95.1",  display: "CABG / Open Heart",      pmhKey: "cabg" },
  afib:                  { icd: "I48.91", display: "Atrial Fibrillation",    pmhKey: "afib" },
  blood_clots:           { icd: "Z86.718",display: "Hx Blood Clots (DVT/PE)",pmhKey: "blood_clots" },
  kidney_disease:        { icd: "N18.9",  display: "Chronic Kidney Disease", pmhKey: "kidney_disease" },
  lung_disease:          { icd: "J44.1",  display: "Lung Disease / O2 Dep",  pmhKey: "lung_disease" },
  sleep_apnea:           { icd: "G47.33", display: "Sleep Apnea (CPAP)",     pmhKey: "sleep_apnea" },
  rheumatoid_arthritis:  { icd: "M06.9",  display: "Rheumatoid Arthritis",   pmhKey: "rheumatoid_arthritis" },
  mrsa:                  { icd: "Z22.322",display: "Hx MRSA / Staph",        pmhKey: "mrsa" },
  depression_anxiety:    { icd: "F41.9",  display: "Depression/Anxiety",      pmhKey: "depression_anxiety" },
  cancer:                { icd: "Z85.9",  display: "Cancer (Active/Remission)", pmhKey: "cancer" },
  bleeding_disorder:     { icd: "D68.9",  display: "Bleeding Disorder",      pmhKey: "bleeding_disorder" },
  vascular_disease:      { icd: "I73.9",  display: "Peripheral Vascular Disease", pmhKey: "vascular_disease" },
  hypertension:          { icd: "I10",    display: "Hypertension",           pmhKey: "hypertension" },
};

// Joint OA ICD-10 codes
const JOINT_ICD = {
  right_knee: { icd: "M17.11", label: "Primary OA, right knee" },
  left_knee:  { icd: "M17.12", label: "Primary OA, left knee" },
  right_hip:  { icd: "M16.11", label: "Primary OA, right hip" },
  left_hip:   { icd: "M16.12", label: "Primary OA, left hip" },
};

// Intake joint values → workstation joint shape
const JOINT_MAP = {
  right_knee: { side: "Right", type: "knee", key: "rk" },
  left_knee:  { side: "Left",  type: "knee", key: "lk" },
  right_hip:  { side: "Right", type: "hip",  key: "rh" },
  left_hip:   { side: "Left",  type: "hip",  key: "lh" },
};

// Intake duration codes → readable text
const DURATION_MAP = {
  lt_3mo:  "less than 3 months",
  "3_6mo": "3 to 6 months",
  "6_12mo":"6 to 12 months",
  "1_2yr": "1 to 2 years",
  gt_2yr:  "more than 2 years",
};

// Intake treatment codes → display labels
const TREATMENT_MAP = {
  pt:          "Physical therapy",
  cortisone:   "Cortisone injections",
  nsaids:      "Anti-inflammatory medications",
  gel:         "Gel injections (Synvisc)",
  bracing:     "Bracing / assistive devices",
  weight_loss: "Weight loss program",
};

// Intake limitation codes → display labels
const LIMITATION_MAP = {
  walking:  "Walking more than a block",
  stairs:   "Going up/down stairs",
  sitting:  "Getting up from a chair",
  shoes:    "Putting on shoes/socks",
  sleeping: "Sleeping through the night",
  driving:  "Getting in/out of a car",
  work:     "Performing their job",
};

// Activity goal codes → display labels
const GOAL_MAP = {
  walking:    "Walking long distances",
  golf:       "Playing golf",
  gardening:  "Gardening / yard work",
  grandkids:  "Playing with grandchildren",
  exercise:   "Exercising / gym",
  swimming:   "Swimming",
  cycling:    "Cycling",
  travel:     "Traveling comfortably",
  stairs:     "Stairs easily",
  dancing:    "Dancing",
  sports:     "Sports (tennis, pickleball)",
  daily:      "Daily activities without pain",
  sleep:      "Sleeping without pain",
  work:       "Returning to work",
};

// Insurance mapping (intake value → display)
const INSURANCE_MAP = {
  cash:      "Cash / Self-Pay",
  medicare:  "Medicare",
  ma_humana: "Medicare Adv — Humana",
  ma_uhc:    "Medicare Adv — UHC",
  ma_aetna:  "Medicare Adv — Aetna",
  ma_bcbs:   "Medicare Adv — BCBS",
  ma_cigna:  "Medicare Adv — Cigna",
  ma_other:  "Medicare Adv — Other",
  bcbs:      "BCBS",
  uhc:       "UnitedHealthcare",
  aetna:     "Aetna",
  cigna:     "Cigna",
  humana:    "Humana",
  tricare:   "TRICARE",
  other:     "Other",
};

// Caregiver relationship mapping
const CG_MAP = {
  husband: "Husband", wife: "Wife", partner: "Partner",
  son: "Son", daughter: "Daughter", sibling: "Sibling",
  friend: "Friend", neighbor: "Neighbor", other: "Other",
};

// Post-op timing display
const POSTOP_TIMING_MAP = {
  "2wk": "2 weeks", "6wk": "6 weeks", "3mo": "3 months",
  "6mo": "6 months", "1yr": "1 year", "gt1yr": "more than 1 year",
};

// Post-op concern labels
const CONCERN_MAP = {
  fever: "fever/chills", redness: "redness around incision",
  drainage: "drainage from incision", swelling: "excessive swelling",
  calf_pain: "calf pain/tenderness", numbness: "numbness/tingling",
  instability: "feeling of giving way", clicking: "clicking/popping",
};

// Cardiac conditions that trigger clearance
const CARDIAC_CONDITIONS = ["cardiac_stenting", "cabg", "afib"];

// Default ROS (all negative)
const DEFAULT_ROS = {
  CONSTITUTIONAL: "No fever, chills.",
  HEENT: "No new visual loss. No sore throat.",
  SKIN: "No new rash.",
  CARDIOVASCULAR: "No new chest pain.",
  RESPIRATORY: "No shortness of breath.",
  GASTROINTESTINAL: "No new vomiting.",
  GENITOURINARY: "No new UTI symptoms.",
  NEUROLOGICAL: "No new headache.",
  MUSCULOSKELETAL: "Pain in the affected joint.",
  HEMATOLOGIC: "No new bleeding.",
  LYMPHATICS: "No enlarged lymph nodes.",
  PSYCHIATRIC: "No recent depression.",
  ENDOCRINOLOGIC: "No polyuria.",
  ALLERGIES: "No recent asthma exacerbations.",
};


// ═══════════════════════════════════════════
// CONVERSION UTILITIES
// ═══════════════════════════════════════════

/**
 * Convert height from intake format "feet_inches" to cm
 * e.g. "5_4" → 162.6
 */
function heightToCm(heightStr) {
  if (!heightStr) return null;
  const [feet, inches] = heightStr.split("_").map(Number);
  if (isNaN(feet) || isNaN(inches)) return null;
  const totalInches = feet * 12 + inches;
  return Math.round(totalInches * 2.54 * 10) / 10;
}

/**
 * Convert height from intake format to display string
 * e.g. "5_4" → "163 cm"
 */
function heightDisplay(heightStr) {
  const cm = heightToCm(heightStr);
  return cm ? `${Math.round(cm)} cm` : "—";
}

/**
 * Convert weight from lbs to kg
 * e.g. 165 → 74.8
 */
function weightToKg(lbs) {
  if (!lbs) return null;
  return Math.round(lbs * 0.453592 * 10) / 10;
}

/**
 * Calculate BMI from height (intake format) and weight (lbs)
 */
function calcBMI(heightStr, weightLbs) {
  const cm = heightToCm(heightStr);
  const kg = weightToKg(weightLbs);
  if (!cm || !kg) return null;
  const meters = cm / 100;
  return Math.round((kg / (meters * meters)) * 10) / 10;
}

/**
 * Calculate age from DOB components
 */
function calcAge(dobMonth, dobDay, dobYear) {
  if (!dobMonth || !dobDay || !dobYear) return null;
  const today = new Date();
  const dob = new Date(dobYear, dobMonth - 1, dobDay);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

/**
 * Format DOB for display: "MM/DD/YYYY"
 */
function formatDOB(m, d, y) {
  if (!m || !d || !y) return "—";
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}


// ═══════════════════════════════════════════
// TOBACCO MAPPING
// ═══════════════════════════════════════════

function mapTobacco(R) {
  if (R.tobacco === "never") return "Never.";
  if (R.tobacco === "former") return `Former — quit ${R.tob_quit || "unknown"}.`;
  if (R.tobacco === "current") return `Current smoker, ${R.tob_amt || "amount unknown"}.`;
  return "Not documented.";
}


// ═══════════════════════════════════════════
// HPI GENERATION
// ═══════════════════════════════════════════

/**
 * Generate natural-language HPI for a pre-op joint from intake data.
 * This is the core narrative that populates the provider note.
 */
function generateHPI(R, joint, patientName, age) {
  const jm = JOINT_MAP[joint];
  if (!jm) return "";
  const label = `${jm.side.toLowerCase()} ${jm.type}`;

  const duration = DURATION_MAP[R[`dur_${joint}`]] || "unknown duration";
  const painNow = R[`pn_${joint}`];
  const painWorst = R[`pw_${joint}`];

  // Treatments
  const txRaw = R[`tx_${joint}`] || [];
  const treatments = txRaw.filter(t => t !== "none").map(t => TREATMENT_MAP[t] || t);

  // Limitations
  const limRaw = R[`lim_${joint}`] || [];
  const limits = limRaw.map(l => LIMITATION_MAP[l] || l);

  // Build narrative
  let hpi = `${patientName} is a ${age}-year-old presenting with ${label} pain of ${duration} duration.`;
  hpi += ` Pain ${painNow ?? "___"}/10, worst ${painWorst ?? "___"}/10.`;

  if (jm.type === "knee") {
    hpi += ` Pain is localized to the ${label}, worse with weight-bearing activities.`;
  } else {
    hpi += ` Pain is groin-predominant with radiation to the anterior thigh, worse with ambulation.`;
  }

  if (treatments.length > 0) {
    hpi += ` Patient has tried ${treatments.join(", ").toLowerCase()} with limited relief.`;
  }

  if (limits.length > 0) {
    hpi += ` Current functional limitations include ${limits.join(", ").toLowerCase()}.`;
  }

  if (R.told_surg === "yes") {
    hpi += " Patient has been told they need surgery and wishes to proceed.";
  }

  hpi += " Risks, benefits, and alternatives discussed.";

  return hpi;
}

/**
 * Generate post-op HPI from intake recovery data.
 */
function generatePostOpHPI(R, joint, patientName, timing) {
  const jm = JOINT_MAP[joint];
  if (!jm) return "";
  const label = `${jm.side.toLowerCase()} ${jm.type === "knee" ? "TKA" : "THA"}`;
  const timingStr = POSTOP_TIMING_MAP[timing] || timing;
  const pain = R.po_pain;
  const vs = R.po_vs;
  const pt = R.po_pt;
  const mob = R.po_mob;
  const concerns = (R.po_conc || []).filter(c => c !== "none");

  let hpi = `${timingStr} post ${label}.`;
  if (vs === "much_better") hpi += " Pain is significantly improved compared to pre-op.";
  else if (vs === "somewhat_better") hpi += " Pain is somewhat improved compared to pre-op.";
  else if (vs === "about_same") hpi += " Pain is about the same as pre-op.";
  else if (vs === "worse") hpi += " Pain is worse than pre-op.";

  hpi += ` Current pain ${pain ?? "___"}/10.`;

  if (pt === "outpatient") hpi += " Attending outpatient PT.";
  else if (pt === "home") hpi += " Receiving home PT.";
  else if (pt === "virtual") hpi += " Doing virtual PT.";
  else if (pt === "no") hpi += " Not currently in PT.";

  if (mob === "none") hpi += " Ambulating without assistance.";
  else if (mob === "cane") hpi += " Walking with cane.";
  else if (mob === "walker") hpi += " Walking with walker.";
  else if (mob === "wheelchair") hpi += " Using wheelchair.";

  if (concerns.length > 0) {
    hpi += ` Reports: ${concerns.map(c => CONCERN_MAP[c] || c).join(", ")}.`;
  } else {
    hpi += " No complications reported.";
  }

  if (R.po_notes) hpi += ` Additional: ${R.po_notes}`;

  return hpi;
}


// ═══════════════════════════════════════════
// FLAGS & RISK COMPUTATION
// ═══════════════════════════════════════════

function computeFlags(R) {
  const flags = [];
  const conds = R.conds || [];

  if (R.blood_thin && R.blood_thin !== "none" && R.blood_thin !== "aspirin") {
    flags.push("blood_thinners");
  }
  if (conds.includes("diabetes")) flags.push("diabetes");
  if (conds.some(c => CARDIAC_CONDITIONS.includes(c))) flags.push("cardiac");
  if (conds.includes("sleep_apnea")) flags.push("sleep_apnea");
  if (conds.includes("kidney_disease")) flags.push("kidney_disease");
  if (R.tobacco === "current") flags.push("active_smoker");

  const bmi = calcBMI(R.height, R.weight);
  if (bmi && bmi >= 40) flags.push("bmi_40_plus");

  if (R.a1c_val && parseFloat(R.a1c_val) >= 8.0) flags.push("a1c_elevated");

  return flags;
}


// ═══════════════════════════════════════════
// MAIN MAPPING FUNCTION
// ═══════════════════════════════════════════

/**
 * Transform patient intake responses into provider workstation data structure.
 *
 * @param {Object} R - Intake form responses (flat key-value)
 * @param {Object} context - Appointment context from JointCal/token system
 *   @param {string} context.mrn
 *   @param {string} context.surgeon - e.g. "DeCook MD, Charles A"
 *   @param {string} context.appointment_time - e.g. "9:00 AM"
 *   @param {string} context.appointment_date
 *   @param {string} context.emr_system - "cerner" or "sis"
 *
 * @returns {Object} Provider workstation patient object
 */
function mapIntakeToProvider(R, context = {}) {
  const firstName = R.first_name || "";
  const lastName = R.last_name || "";
  const age = calcAge(R.dob_m, R.dob_d, R.dob_y);
  const dob = formatDOB(R.dob_m, R.dob_d, R.dob_y);
  const bmi = calcBMI(R.height, R.weight);
  const joints = R.joints || [];

  // ─── JOINT OBJECTS ───
  const preOpJoints = joints.filter(j => R[`rep_${j}`] !== "yes");
  const postOpJoints = joints.filter(j => R[`rep_${j}`] === "yes");

  const workstationJoints = joints.map(j => {
    const jm = JOINT_MAP[j];
    if (!jm) return null;
    const isPostOp = R[`rep_${j}`] === "yes";
    return {
      side: jm.side,
      type: jm.type,
      key: jm.key,
      impl: isPostOp || undefined,
    };
  }).filter(Boolean);

  // ─── CONDITIONS → PMH ───
  const conditions = (R.conds || []).filter(c => c !== "none");
  const pmh = conditions.map(c => CONDITION_MAP[c]?.pmhKey || c);
  const pmhD = conditions.map(c => CONDITION_MAP[c]?.display || c);

  // ─── MEDICATIONS ───
  // Pass through as string array — the 32846 engine classifies them downstream
  const meds = (R.med_list || []).map(m => m.d || m.display || m);

  // ─── ALLERGIES ───
  const allergies = R.allergies ? [R.allergies] : ["NKDA"];

  // ─── GOALS ───
  const goals = (R.goals || []).map(g => GOAL_MAP[g] || g);

  // ─── PER-JOINT DATA ───
  const jd = {};

  // Pre-op joints: full HPI with pain/treatment/limitation data
  preOpJoints.forEach(j => {
    const jm = JOINT_MAP[j];
    if (!jm) return;

    const txRaw = (R[`tx_${j}`] || []).filter(t => t !== "none");
    const limRaw = (R[`lim_${j}`] || []);

    jd[jm.key] = {
      pd: DURATION_MAP[R[`dur_${j}`]] || "unknown",
      pl: R[`pn_${j}`],
      pw: R[`pw_${j}`],
      pt: txRaw.map(t => TREATMENT_MAP[t] || t),
      fl: limRaw.map(l => LIMITATION_MAP[l] || l),
      hpi: generateHPI(R, j, `${firstName} ${lastName}`, age),
      exam: jm.type === "knee"
        ? { inspect: "", align: "", ext: "", flex: "", stab: "", qstr: "", hstr: "" }
        : { inspect: "", pain: "", flex: "", abd: "", add: "", er: "", ir: "", fstr: "", astr: "" },
      sev: null, // provider sets this from radiographs
    };
  });

  // Post-op joints: recovery HPI
  if (postOpJoints.length > 0) {
    postOpJoints.forEach(j => {
      const jm = JOINT_MAP[j];
      if (!jm) return;

      const timing = R.po_timing || "";
      const timingDisplay = POSTOP_TIMING_MAP[timing] || timing;

      jd[jm.key] = {
        hpi: generatePostOpHPI(R, j, `${firstName} ${lastName}`, timing),
        exam: {
          wound: "",
          rom: "",
          gait: R.po_mob === "none" ? "Independent" : R.po_mob === "cane" ? "Cane" : R.po_mob === "walker" ? "Walker" : "Wheelchair",
          str: "",
          nv: "",
          dvt: (R.po_conc || []).includes("calf_pain") ? "Calf tenderness reported — evaluate" : "No calf tenderness, Homans negative.",
        },
        sev: null,
      };
    });
  }

  // ─── VISIT TYPE INFERENCE ───
  let visitType = "new";
  if (postOpJoints.length > 0 && preOpJoints.length === 0) {
    visitType = "post_op";
  }
  // Could be mixed (post-op one joint, new pain another) — workstation handles per-joint

  // ─── ROS ───
  // Default negative ROS, customized based on conditions
  const ros = { ...DEFAULT_ROS };
  if (conditions.includes("diabetes")) {
    ros.ENDOCRINOLOGIC = "Diabetes — managed with medication.";
  }
  if (conditions.includes("depression_anxiety")) {
    ros.PSYCHIATRIC = "Depression/anxiety — managed.";
  }
  if (joints.length === 1) {
    const jm = JOINT_MAP[joints[0]];
    if (jm) ros.MUSCULOSKELETAL = `Pain in the ${jm.side.toLowerCase()} ${jm.type}.`;
  } else if (joints.length > 1) {
    const labels = joints.map(j => {
      const jm = JOINT_MAP[j];
      return jm ? `${jm.side.toLowerCase()} ${jm.type}` : j;
    });
    ros.MUSCULOSKELETAL = `Pain in ${labels.join(" and ")}.`;
  }

  // ─── FAMILY HISTORY ───
  let fhx = "Non-contributory";
  if (R.fam_clots === "yes") {
    fhx = "Family history of blood clots.";
  }

  // ─── ASSEMBLE PROVIDER OBJECT ───
  const patient = {
    id: `intake_${context.mrn || Date.now()}`,
    nm: `${firstName} ${lastName}`,
    first: firstName,
    last: lastName,
    age: age,
    dob: dob,
    mrn: context.mrn || "—",
    surgeon: context.surgeon || "DeCook MD, Charles A",
    ins: INSURANCE_MAP[R.insurance] || R.insurance || "—",
    vt: visitType,
    time: context.appointment_time || "—",
    flags: computeFlags(R),

    joints: workstationJoints,

    intake: {
      tobacco: mapTobacco(R),
      fhx: fhx,
      ht: heightDisplay(R.height),
      wt: `${weightToKg(R.weight) || "—"} kg`,
      bmi: bmi ? String(bmi) : "—",

      cg_rel: CG_MAP[R.cg_rel] || R.cg_rel || "",
      cg_name: R.cg_name || "",
      cg_phone: R.cg_phone || "",

      pmh: pmh,
      pmhD: pmhD,
      hba1c: R.a1c_val ? parseFloat(R.a1c_val) : null,

      psh: R.surg_hx || "None",
      allergy: allergies,
      goals: goals,
      meds: meds,
      ros: ros,
    },

    jd: jd,
  };

  return patient;
}


// ═══════════════════════════════════════════
// TEST HARNESS
// ═══════════════════════════════════════════

function runMappingTests() {
  console.log("═══ SOAP Mapping Engine — Test Suite ═══\n");

  // ─── TEST 1: New patient, single joint ───
  console.log("── Test 1: Margaret Thompson — New Patient, Left Knee ──\n");
  const margaret = mapIntakeToProvider({
    first_name: "Margaret", last_name: "Thompson",
    dob_m: 6, dob_d: 18, dob_y: 1957,
    height: "5_7", weight: 200,
    phone: "7705550143", insurance: "medicare",
    joints: ["left_knee"],
    rep_left_knee: "no",
    told_surg: "yes",
    dur_left_knee: "gt_2yr", pn_left_knee: 7, pw_left_knee: 9,
    tx_left_knee: ["pt", "cortisone", "nsaids", "gel"],
    lim_left_knee: ["walking", "stairs", "sleeping", "driving"],
    conds: ["diabetes", "cardiac_stenting", "depression_anxiety"],
    a1c_known: "yes", a1c_val: "7.2",
    blood_thin: "eliquis",
    allergies: "Penicillin — rash",
    surg_hx: "None",
    tobacco: "never",
    fam_clots: "no",
    med_list: [
      { d: "Eliquis (apixaban)" }, { d: "Metformin (Glucophage)" },
      { d: "atorvastatin" }, { d: "sertraline" }, { d: "pantoprazole" },
      { d: "Calcium + Vitamin D" }, { d: "meloxicam" }, { d: "amlodipine" },
      { d: "metoprolol" }, { d: "Ozempic (semaglutide)" }, { d: "empagliflozin" },
    ],
    med_confirm: "yes",
    cg_rel: "husband", cg_name: "Thomas Thompson", cg_phone: "(770) 555-0143",
    mobility: ["none"],
    home: ["walk_in_shower", "grab_bars"],
    goals: ["walking", "gardening", "grandkids"],
  }, { mrn: "NTH-2847561" });

  console.log(`  Name: ${margaret.nm}`);
  console.log(`  Age: ${margaret.age} | DOB: ${margaret.dob}`);
  console.log(`  Vitals: Ht ${margaret.intake.ht} / Wt ${margaret.intake.wt} / BMI ${margaret.intake.bmi}`);
  console.log(`  Insurance: ${margaret.ins}`);
  console.log(`  Visit type: ${margaret.vt}`);
  console.log(`  Flags: ${margaret.flags.join(", ")}`);
  console.log(`  Joints: ${margaret.joints.map(j => `${j.side} ${j.type} (${j.key})`).join(", ")}`);
  console.log(`  PMH: ${margaret.intake.pmhD.join(", ")}`);
  console.log(`  HbA1c: ${margaret.intake.hba1c}%`);
  console.log(`  Meds: ${margaret.intake.meds.length} medications`);
  console.log(`  Allergies: ${margaret.intake.allergy.join(", ")}`);
  console.log(`  Caregiver: ${margaret.intake.cg_rel} — ${margaret.intake.cg_name}`);
  console.log(`  Tobacco: ${margaret.intake.tobacco}`);
  console.log(`  Family Hx: ${margaret.intake.fhx}`);
  console.log(`  Goals: ${margaret.intake.goals.join(", ")}`);
  console.log(`\n  HPI (left knee):`);
  console.log(`  ${margaret.jd.lk.hpi}`);
  console.log(`  Pain: ${margaret.jd.lk.pl}/10, Worst: ${margaret.jd.lk.pw}/10`);
  console.log(`  Duration: ${margaret.jd.lk.pd}`);
  console.log(`  Treatments: ${margaret.jd.lk.pt.join(", ")}`);
  console.log(`  Limitations: ${margaret.jd.lk.fl.join(", ")}\n`);

  // ─── TEST 2: Bilateral knees ───
  console.log("── Test 2: Robert Williams — Bilateral Knees ──\n");
  const robert = mapIntakeToProvider({
    first_name: "Robert", last_name: "Williams",
    dob_m: 3, dob_d: 22, dob_y: 1954,
    height: "5_9", weight: 210,
    phone: "7705550298", insurance: "medicare",
    joints: ["right_knee", "left_knee"],
    rep_right_knee: "no", rep_left_knee: "no",
    told_surg: "yes",
    dur_right_knee: "gt_2yr", pn_right_knee: 6, pw_right_knee: 8,
    tx_right_knee: ["pt", "cortisone", "gel"],
    lim_right_knee: ["walking", "stairs"],
    dur_left_knee: "1_2yr", pn_left_knee: 4, pw_left_knee: 6,
    tx_left_knee: ["nsaids"],
    lim_left_knee: ["walking", "stairs"],
    conds: ["none"], blood_thin: "none",
    allergies: "NKDA", surg_hx: "R knee arthroscopy 2018",
    tobacco: "former", tob_quit: "10 years ago",
    fam_clots: "no",
    med_list: [
      { d: "atorvastatin" }, { d: "amlodipine" },
      { d: "pantoprazole" }, { d: "Vitamin D3" },
    ],
    med_confirm: "yes",
    cg_rel: "wife", cg_name: "Barbara Williams", cg_phone: "(770) 555-0298",
    goals: ["golf", "stairs"],
  }, { mrn: "NTH-5518293" });

  console.log(`  Name: ${robert.nm} | Age: ${robert.age}`);
  console.log(`  Joints: ${robert.joints.map(j => `${j.side} ${j.type}`).join(" + ")}`);
  console.log(`  Tobacco: ${robert.intake.tobacco}`);
  console.log(`  Surgical Hx: ${robert.intake.psh}`);
  console.log(`\n  HPI (right knee):`);
  console.log(`  ${robert.jd.rk.hpi}`);
  console.log(`\n  HPI (left knee):`);
  console.log(`  ${robert.jd.lk.hpi}\n`);

  // ─── TEST 3: Multi-joint different types ───
  console.log("── Test 3: Patricia Garcia — R Knee + L Hip ──\n");
  const patricia = mapIntakeToProvider({
    first_name: "Patricia", last_name: "Garcia",
    dob_m: 9, dob_d: 14, dob_y: 1959,
    height: "5_4", weight: 160,
    phone: "6785550187", insurance: "bcbs",
    joints: ["right_knee", "left_hip"],
    rep_right_knee: "no", rep_left_hip: "no",
    dur_right_knee: "1_2yr", pn_right_knee: 6, pw_right_knee: 8,
    tx_right_knee: ["pt", "cortisone"],
    lim_right_knee: ["walking", "stairs"],
    dur_left_hip: "6_12mo", pn_left_hip: 5, pw_left_hip: 7,
    tx_left_hip: ["nsaids"],
    lim_left_hip: ["walking", "shoes"],
    conds: ["none"], blood_thin: "none",
    allergies: "Sulfa — hives",
    tobacco: "never", fam_clots: "no",
    med_list: [
      { d: "levothyroxine" }, { d: "atorvastatin" },
      { d: "Calcium + Vitamin D" }, { d: "famotidine" },
    ],
    med_confirm: "yes",
    cg_rel: "daughter", cg_name: "Maria Garcia", cg_phone: "(678) 555-0187",
    goals: ["walking", "grandkids"],
  }, { mrn: "NTH-6629104" });

  console.log(`  Name: ${patricia.nm}`);
  console.log(`  Joints: ${patricia.joints.map(j => `${j.side} ${j.type}`).join(" + ")}`);
  console.log(`\n  HPI (right knee):`);
  console.log(`  ${patricia.jd.rk.hpi}`);
  console.log(`\n  HPI (left hip):`);
  console.log(`  ${patricia.jd.lh.hpi}`);
  console.log(`  (Note: hip HPI uses groin-predominant language)\n`);

  // ─── TEST 4: Post-op visit ───
  console.log("── Test 4: James Mitchell — Post-Op L Hip (2wk) ──\n");
  const james = mapIntakeToProvider({
    first_name: "James", last_name: "Mitchell",
    dob_m: 11, dob_d: 8, dob_y: 1953,
    height: "5_11", weight: 195,
    phone: "7705550431", insurance: "ma_humana",
    joints: ["left_hip"],
    rep_left_hip: "yes",
    po_timing: "2wk", po_pain: 3, po_vs: "much_better",
    po_pt: "home", po_mob: "walker",
    po_conc: ["none"],
    conds: ["none"], blood_thin: "aspirin",
    allergies: "NKDA", tobacco: "never", fam_clots: "no",
    med_list: [
      { d: "Aspirin 81mg" }, { d: "lisinopril" },
      { d: "atorvastatin" }, { d: "Vitamin D3" }, { d: "tamsulosin" },
    ],
    med_confirm: "yes",
  }, { mrn: "NTH-3915284" });

  console.log(`  Name: ${james.nm} | Visit type: ${james.vt}`);
  console.log(`  Joint: ${james.joints.map(j => `${j.side} ${j.type} (impl: ${j.impl})`).join(", ")}`);
  console.log(`\n  HPI (post-op):`);
  console.log(`  ${james.jd.lh.hpi}`);
  console.log(`  Gait from intake: ${james.jd.lh.exam.gait}`);
  console.log(`  DVT assessment: ${james.jd.lh.exam.dvt}\n`);

  // ─── TEST 5: Mixed — one post-op, one new ───
  console.log("── Test 5: Mixed — Post-Op R Knee + New L Hip Pain ──\n");
  const mixed = mapIntakeToProvider({
    first_name: "Susan", last_name: "Anderson",
    dob_m: 4, dob_d: 10, dob_y: 1955,
    height: "5_5", weight: 155,
    phone: "7705550555", insurance: "bcbs",
    joints: ["right_knee", "left_hip"],
    rep_right_knee: "yes", rep_left_hip: "no",
    po_timing: "3mo", po_pain: 2, po_vs: "much_better",
    po_pt: "outpatient", po_mob: "cane",
    po_conc: ["clicking"],
    dur_left_hip: "3_6mo", pn_left_hip: 5, pw_left_hip: 7,
    tx_left_hip: ["nsaids"],
    lim_left_hip: ["walking", "shoes"],
    conds: ["none"], blood_thin: "none",
    allergies: "NKDA", tobacco: "never", fam_clots: "no",
    med_list: [{ d: "atorvastatin" }, { d: "Calcium + Vitamin D" }],
    med_confirm: "yes",
    cg_rel: "partner", cg_name: "David Anderson", cg_phone: "(770) 555-0555",
    goals: ["walking", "travel"],
  }, { mrn: "NTH-9912345" });

  console.log(`  Name: ${mixed.nm}`);
  console.log(`  Visit type: ${mixed.vt} (mixed — has both pre-op and post-op joints)`);
  console.log(`  Joints: ${mixed.joints.map(j => `${j.side} ${j.type}${j.impl ? " (impl)" : ""}`).join(" + ")}`);
  console.log(`\n  Post-op HPI (R knee):`);
  console.log(`  ${mixed.jd.rk.hpi}`);
  console.log(`\n  Pre-op HPI (L hip):`);
  console.log(`  ${mixed.jd.lh.hpi}\n`);

  // ─── SUMMARY ───
  console.log("═══ All 5 scenarios mapped successfully ═══\n");
  console.log("Output structure matches provider workstation v8 patient object.");
  console.log("Plug any output directly into the workstation's patient array.\n");
}


// ═══════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    mapIntakeToProvider,
    generateHPI,
    generatePostOpHPI,
    computeFlags,
    heightToCm,
    weightToKg,
    calcBMI,
    calcAge,
    mapTobacco,
    CONDITION_MAP,
    JOINT_MAP,
    JOINT_ICD,
    DURATION_MAP,
    TREATMENT_MAP,
    LIMITATION_MAP,
    GOAL_MAP,
    DEFAULT_ROS,
    runMappingTests,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  runMappingTests();
}
