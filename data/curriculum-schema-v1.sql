-- Normalized schema for degree curricula and their source-backed requirements.
-- The current database installs this structure only; no requirement rows are certified yet.
CREATE TABLE IF NOT EXISTS course_concept (
  concept_id TEXT PRIMARY KEY,
  canonical_title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS course_concept_offering (
  concept_id TEXT NOT NULL REFERENCES course_concept(concept_id) ON DELETE RESTRICT,
  offering_id TEXT NOT NULL REFERENCES course_offering(offering_id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('same-course','renamed','successor','related')),
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_page INTEGER NOT NULL CHECK (source_page > 0),
  evidence_text TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (concept_id, offering_id)
);

CREATE TABLE IF NOT EXISTS curriculum_program (
  program_id TEXT PRIMARY KEY,
  program_code TEXT NOT NULL DEFAULT '',
  program_name TEXT NOT NULL,
  degree_level TEXT NOT NULL
    CHECK (degree_level IN ('undergraduate','graduate','other','unknown')),
  campus TEXT NOT NULL DEFAULT 'unknown',
  organizational_unit TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS curriculum_plan_version (
  plan_version_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES curriculum_program(program_id),
  admission_year_start INTEGER NOT NULL,
  admission_year_end INTEGER,
  publication_academic_year INTEGER NOT NULL,
  version_label TEXT NOT NULL DEFAULT '',
  effective_from TEXT NOT NULL DEFAULT '',
  effective_to TEXT NOT NULL DEFAULT '',
  version_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (version_status IN ('draft','provisional','approved','superseded')),
  notes TEXT NOT NULL DEFAULT '',
  CHECK (admission_year_start BETWEEN 1900 AND 2200),
  CHECK (admission_year_end IS NULL OR admission_year_end >= admission_year_start),
  CHECK (publication_academic_year BETWEEN 1900 AND 2200),
  UNIQUE (program_id, admission_year_start, version_label)
);

CREATE TABLE IF NOT EXISTS curriculum_version_source (
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_role TEXT NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  PRIMARY KEY (plan_version_id, source_id, source_role),
  CHECK (page_start IS NULL OR page_start > 0),
  CHECK (page_end IS NULL OR page_end >= COALESCE(page_start, 1))
);

-- Evidence for the cohort/program applicability declared by a plan version.
CREATE TABLE IF NOT EXISTS curriculum_plan_version_evidence (
  evidence_id INTEGER PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  evidence_role TEXT NOT NULL DEFAULT 'applicability',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_section (
  section_id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  parent_section_id TEXT REFERENCES curriculum_section(section_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  printed_section_code TEXT NOT NULL DEFAULT '',
  section_title TEXT NOT NULL,
  section_type TEXT NOT NULL DEFAULT 'unknown',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_section_evidence (
  evidence_id INTEGER PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES curriculum_section(section_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  raw_record_json TEXT NOT NULL DEFAULT '{}',
  extraction_method TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_course_reference (
  course_ref_id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  section_id TEXT REFERENCES curriculum_section(section_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  printed_course_code TEXT NOT NULL DEFAULT '',
  printed_title TEXT NOT NULL,
  title_key TEXT NOT NULL DEFAULT '',
  credits REAL CHECK (credits IS NULL OR credits >= 0),
  recommended_year INTEGER CHECK (recommended_year IS NULL OR recommended_year > 0),
  semester_label TEXT NOT NULL DEFAULT '',
  requirement_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (requirement_kind IN ('required','elective','choice','conditional','unknown')),
  notes TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_course_reference_evidence (
  evidence_id INTEGER PRIMARY KEY,
  course_ref_id TEXT NOT NULL REFERENCES curriculum_course_reference(course_ref_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  table_or_section TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  raw_row_json TEXT NOT NULL DEFAULT '{}',
  extraction_method TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_requirement_group (
  requirement_group_id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  parent_group_id TEXT REFERENCES curriculum_requirement_group(requirement_group_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  group_title TEXT NOT NULL,
  rule_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (rule_kind IN ('all','any','choose_count','minimum_credits','choose_credits','at_least_one','sequence','unknown')),
  min_course_count INTEGER CHECK (min_course_count IS NULL OR min_course_count >= 0),
  max_course_count INTEGER CHECK (max_course_count IS NULL OR max_course_count >= 0),
  min_credits REAL CHECK (min_credits IS NULL OR min_credits >= 0),
  max_credits REAL CHECK (max_credits IS NULL OR max_credits >= 0),
  exact_rule_text TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  CHECK (min_course_count IS NULL OR max_course_count IS NULL OR min_course_count <= max_course_count),
  CHECK (min_credits IS NULL OR max_credits IS NULL OR min_credits <= max_credits)
);

CREATE TABLE IF NOT EXISTS curriculum_requirement_member (
  requirement_group_id TEXT NOT NULL REFERENCES curriculum_requirement_group(requirement_group_id) ON DELETE RESTRICT,
  course_ref_id TEXT NOT NULL REFERENCES curriculum_course_reference(course_ref_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  member_kind TEXT NOT NULL DEFAULT 'required'
    CHECK (member_kind IN ('required','choice','alternative')),
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  PRIMARY KEY (requirement_group_id, course_ref_id)
);

CREATE TABLE IF NOT EXISTS curriculum_requirement_evidence (
  evidence_id INTEGER PRIMARY KEY,
  requirement_group_id TEXT NOT NULL REFERENCES curriculum_requirement_group(requirement_group_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  raw_record_json TEXT NOT NULL DEFAULT '{}',
  extraction_method TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_rule (
  rule_id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  rule_kind TEXT NOT NULL
    CHECK (rule_kind IN ('prerequisite','registration','advancement','graduation','credit_limit','language','other')),
  rule_title TEXT NOT NULL DEFAULT '',
  exact_rule_text TEXT NOT NULL,
  expression_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (expression_schema_version > 0),
  expression_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(expression_json)),
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE TABLE IF NOT EXISTS curriculum_rule_evidence (
  evidence_id INTEGER PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES curriculum_rule(rule_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  raw_record_json TEXT NOT NULL DEFAULT '{}',
  extraction_method TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

-- A rule may apply to one or more courses, requirement groups, or sections.
CREATE TABLE IF NOT EXISTS curriculum_rule_course_target (
  rule_id TEXT NOT NULL REFERENCES curriculum_rule(rule_id) ON DELETE RESTRICT,
  course_ref_id TEXT NOT NULL REFERENCES curriculum_course_reference(course_ref_id) ON DELETE RESTRICT,
  PRIMARY KEY (rule_id, course_ref_id)
);

CREATE TABLE IF NOT EXISTS curriculum_rule_group_target (
  rule_id TEXT NOT NULL REFERENCES curriculum_rule(rule_id) ON DELETE RESTRICT,
  requirement_group_id TEXT NOT NULL REFERENCES curriculum_requirement_group(requirement_group_id) ON DELETE RESTRICT,
  PRIMARY KEY (rule_id, requirement_group_id)
);

CREATE TABLE IF NOT EXISTS curriculum_rule_section_target (
  rule_id TEXT NOT NULL REFERENCES curriculum_rule(rule_id) ON DELETE RESTRICT,
  section_id TEXT NOT NULL REFERENCES curriculum_section(section_id) ON DELETE RESTRICT,
  PRIMARY KEY (rule_id, section_id)
);

-- Corrections and addenda are retained as source-backed events, never as silent overwrites.
CREATE TABLE IF NOT EXISTS curriculum_revision_event (
  revision_event_id INTEGER PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES curriculum_plan_version(plan_version_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  printed_page_label TEXT NOT NULL DEFAULT '',
  revision_label TEXT NOT NULL DEFAULT '',
  published_on TEXT NOT NULL DEFAULT '',
  target_course_ref_id TEXT REFERENCES curriculum_course_reference(course_ref_id) ON DELETE RESTRICT,
  target_requirement_group_id TEXT REFERENCES curriculum_requirement_group(requirement_group_id) ON DELETE RESTRICT,
  target_rule_id TEXT REFERENCES curriculum_rule(rule_id) ON DELETE RESTRICT,
  target_section_id TEXT REFERENCES curriculum_section(section_id) ON DELETE RESTRICT,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('add','replace','remove','clarify','other')),
  exact_change_text TEXT NOT NULL,
  before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  reviewed_at TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL DEFAULT '',
  CHECK ((target_course_ref_id IS NOT NULL) + (target_requirement_group_id IS NOT NULL)
       + (target_rule_id IS NOT NULL) + (target_section_id IS NOT NULL) <= 1)
);

CREATE TABLE IF NOT EXISTS curriculum_course_offering_link (
  link_id INTEGER PRIMARY KEY,
  course_ref_id TEXT NOT NULL REFERENCES curriculum_course_reference(course_ref_id) ON DELETE RESTRICT,
  offering_id TEXT NOT NULL REFERENCES course_offering(offering_id) ON DELETE RESTRICT,
  link_type TEXT NOT NULL DEFAULT 'same-course'
    CHECK (link_type IN ('same-course','equivalent','partial-match')),
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded')),
  reviewed_at TEXT NOT NULL DEFAULT '',
  UNIQUE (course_ref_id, offering_id)
);

CREATE TABLE IF NOT EXISTS curriculum_course_offering_link_evidence (
  evidence_id INTEGER PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES curriculum_course_offering_link(link_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES source_document(source_id),
  source_sha256 TEXT NOT NULL,
  pdf_page_no INTEGER NOT NULL CHECK (pdf_page_no > 0),
  excerpt TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'provisional'
    CHECK (review_status IN ('provisional','reviewed','approved','rejected','superseded'))
);

CREATE INDEX IF NOT EXISTS ix_course_concept_title ON course_concept(title_key);
CREATE INDEX IF NOT EXISTS ix_course_concept_offering_offering ON course_concept_offering(offering_id);
CREATE INDEX IF NOT EXISTS ix_curriculum_plan_cohort ON curriculum_plan_version(program_id,admission_year_start,admission_year_end);
CREATE INDEX IF NOT EXISTS ix_curriculum_section_parent ON curriculum_section(plan_version_id,parent_section_id,ordinal);
CREATE INDEX IF NOT EXISTS ix_curriculum_course_ref_code ON curriculum_course_reference(plan_version_id,printed_course_code);
CREATE INDEX IF NOT EXISTS ix_curriculum_course_ref_title ON curriculum_course_reference(plan_version_id,title_key);
CREATE INDEX IF NOT EXISTS ix_curriculum_requirement_tree ON curriculum_requirement_group(plan_version_id,parent_group_id,ordinal);
CREATE INDEX IF NOT EXISTS ix_curriculum_link_offering ON curriculum_course_offering_link(offering_id,review_status);
CREATE INDEX IF NOT EXISTS ix_curriculum_evidence_source_page ON curriculum_course_reference_evidence(source_id,pdf_page_no);
CREATE INDEX IF NOT EXISTS ix_curriculum_version_evidence_source ON curriculum_plan_version_evidence(source_id,pdf_page_no);
CREATE INDEX IF NOT EXISTS ix_curriculum_revision_target ON curriculum_revision_event(plan_version_id,review_status);
CREATE INDEX IF NOT EXISTS ix_curriculum_rule_course_target ON curriculum_rule_course_target(course_ref_id,rule_id);
CREATE INDEX IF NOT EXISTS ix_curriculum_rule_group_target ON curriculum_rule_group_target(requirement_group_id,rule_id);
CREATE INDEX IF NOT EXISTS ix_curriculum_rule_section_target ON curriculum_rule_section_target(section_id,rule_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_curriculum_section_sibling_order
  ON curriculum_section(plan_version_id,ifnull(parent_section_id,''),ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS ux_curriculum_reference_sibling_order
  ON curriculum_course_reference(plan_version_id,ifnull(section_id,''),ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS ux_curriculum_requirement_sibling_order
  ON curriculum_requirement_group(plan_version_id,ifnull(parent_group_id,''),ordinal);

CREATE TRIGGER IF NOT EXISTS curriculum_section_parent_same_version_insert
BEFORE INSERT ON curriculum_section
WHEN NEW.parent_section_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.parent_section_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum section parent must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_section_parent_same_version_update
BEFORE UPDATE OF plan_version_id,parent_section_id ON curriculum_section
WHEN NEW.parent_section_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.parent_section_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum section parent must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_course_reference_section_same_version_insert
BEFORE INSERT ON curriculum_course_reference
WHEN NEW.section_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.section_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum course reference section must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_course_reference_section_same_version_update
BEFORE UPDATE OF plan_version_id,section_id ON curriculum_course_reference
WHEN NEW.section_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.section_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum course reference section must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_requirement_parent_same_version_insert
BEFORE INSERT ON curriculum_requirement_group
WHEN NEW.parent_group_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.parent_group_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum requirement parent must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_requirement_parent_same_version_update
BEFORE UPDATE OF plan_version_id,parent_group_id ON curriculum_requirement_group
WHEN NEW.parent_group_id IS NOT NULL
  AND (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.parent_group_id) IS NOT NEW.plan_version_id
BEGIN
  SELECT RAISE(ABORT,'curriculum requirement parent must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_requirement_member_same_version_insert
BEFORE INSERT ON curriculum_requirement_member
WHEN (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.requirement_group_id)
     IS NOT (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.course_ref_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum requirement member must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_requirement_member_same_version_update
BEFORE UPDATE OF requirement_group_id,course_ref_id ON curriculum_requirement_member
WHEN (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.requirement_group_id)
     IS NOT (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.course_ref_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum requirement member must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_rule_course_target_same_version_insert
BEFORE INSERT ON curriculum_rule_course_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.course_ref_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and course target must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_rule_course_target_same_version_update
BEFORE UPDATE OF rule_id,course_ref_id ON curriculum_rule_course_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.course_ref_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and course target must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_rule_group_target_same_version_insert
BEFORE INSERT ON curriculum_rule_group_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.requirement_group_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and requirement target must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_rule_group_target_same_version_update
BEFORE UPDATE OF rule_id,requirement_group_id ON curriculum_rule_group_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.requirement_group_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and requirement target must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_rule_section_target_same_version_insert
BEFORE INSERT ON curriculum_rule_section_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.section_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and section target must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_rule_section_target_same_version_update
BEFORE UPDATE OF rule_id,section_id ON curriculum_rule_section_target
WHEN (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.rule_id)
     IS NOT (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.section_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum rule and section target must be in the same plan version');
END;

CREATE TRIGGER IF NOT EXISTS curriculum_revision_target_same_version_insert
BEFORE INSERT ON curriculum_revision_event
WHEN (NEW.target_course_ref_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.target_course_ref_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_requirement_group_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.target_requirement_group_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_rule_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.target_rule_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_section_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.target_section_id) IS NOT NEW.plan_version_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum revision target must be in the same plan version');
END;
CREATE TRIGGER IF NOT EXISTS curriculum_revision_target_same_version_update
BEFORE UPDATE OF plan_version_id,target_course_ref_id,target_requirement_group_id,target_rule_id,target_section_id
ON curriculum_revision_event
WHEN (NEW.target_course_ref_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_course_reference WHERE course_ref_id=NEW.target_course_ref_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_requirement_group_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_requirement_group WHERE requirement_group_id=NEW.target_requirement_group_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_rule_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_rule WHERE rule_id=NEW.target_rule_id) IS NOT NEW.plan_version_id)
  OR (NEW.target_section_id IS NOT NULL AND
      (SELECT plan_version_id FROM curriculum_section WHERE section_id=NEW.target_section_id) IS NOT NEW.plan_version_id)
BEGIN
  SELECT RAISE(ABORT,'curriculum revision target must be in the same plan version');
END;
