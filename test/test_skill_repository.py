import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.skills import parse_skill_metadata, render_available_skills
from agent.infrastructure.skills import SkillRepository

ALL_ON: dict[str, bool] = {}


def _write(root: Path, folder: str, frontmatter: str, body: str = "Body") -> Path:
    skill_file = root / folder / "SKILL.md"
    skill_file.parent.mkdir(parents=True, exist_ok=True)
    skill_file.write_text(f"---\n{frontmatter}\n---\n\n{body}\n", encoding="utf-8")
    return skill_file


def _skill(root: Path, name: str, description: str, body: str = "Body") -> Path:
    return _write(root, name, f"name: {name}\ndescription: {description}", body)


def _repository(tmp_path: Path, **kwargs) -> SkillRepository:
    return SkillRepository(tmp_path / "work", home=tmp_path / "home", rind_home=tmp_path / "rind", **kwargs)


def test_block_scalar_descriptions_are_joined_into_one_line() -> None:
    text = "---\nname: pdf\ndescription: |\n  Fill PDF forms.\n  Use for invoices.\n---\nBody\n"
    metadata, warning = parse_skill_metadata(text, "/s/pdf/SKILL.md", "pdf", "rind_user")
    assert metadata.description == "Fill PDF forms. Use for invoices."
    assert warning is None


def test_nested_fields_never_replace_the_top_level_ones() -> None:
    text = "---\nname: pdf\ndescription: Top\nmetadata:\n  name: other\n  description: Nested\nallowed-tools:\n  - Bash(x *)\n---\nBody\n"
    metadata, _warning = parse_skill_metadata(text, "/s/pdf/SKILL.md", "pdf", "rind_user")
    assert (metadata.name, metadata.description) == ("pdf", "Top")


def test_an_unquoted_colon_in_a_value_is_repaired() -> None:
    text = "---\nname: pdf\ndescription: Use when: forms, invoices\n---\nBody\n"
    metadata, _warning = parse_skill_metadata(text, "/s/pdf/SKILL.md", "pdf", "rind_user")
    assert metadata.description == "Use when: forms, invoices"


def test_name_defaults_to_the_folder_and_a_mismatch_only_warns() -> None:
    defaulted, _warning = parse_skill_metadata("---\ndescription: D\n---\n", "/s/x/SKILL.md", "x", "rind_user")
    renamed, warning = parse_skill_metadata("---\nname: y\ndescription: D\n---\n", "/s/x/SKILL.md", "x", "rind_user")
    assert defaulted.name == "x"
    assert renamed.name == "y" and "differs from its folder" in warning


@pytest.mark.parametrize("frontmatter, message", [
    ("name: x", "missing description"),
    ("name: bad/name\ndescription: D", "invalid name"),
    ("- a list", "must be a mapping"),
])
def test_invalid_frontmatter_is_rejected_with_a_reason(frontmatter: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_skill_metadata(f"---\n{frontmatter}\n---\n", "/s/x/SKILL.md", "x", "rind_user")


def test_layers_override_in_order_and_switched_off_imports_are_skipped(tmp_path: Path) -> None:
    home, work = tmp_path / "home", tmp_path / "work"
    _skill(home / ".claude" / "skills", "shared", "claude user")
    _skill(home / ".codex" / "skills", "shared", "codex legacy")
    _skill(home / ".agents" / "skills", "shared", "agents user")
    _skill(work / ".claude" / "skills", "only-claude", "claude project")
    _skill(work / ".rind" / "skills", "local", "rind project")
    repository = _repository(tmp_path)

    everything = {skill.name: skill for skill in repository.list_skills(ALL_ON)}
    claude_off = {skill.name for skill in repository.list_skills({"claude_project": False})}

    assert everything["shared"].description == "agents user"
    assert everything["only-claude"].source == "claude_project"
    assert {"skill-creator", "local"} <= set(everything)
    assert "only-claude" not in claude_off


def test_hidden_folders_and_invalid_skills_are_skipped_but_reported(tmp_path: Path) -> None:
    root = tmp_path / "home" / ".codex" / "skills"
    _skill(root / ".system", "bundled", "Codex internal")
    _write(root, "broken", "name: broken")
    repository = _repository(tmp_path)

    scan = repository.scan(ALL_ON)
    codex = next(scanned for scanned in scan.sources if scanned.source.id == "codex_user")

    assert "bundled" not in scan.effective()
    assert [problem.message for problem in codex.problems] == ["missing description."]


def test_a_symlinked_skill_folder_is_followed(tmp_path: Path) -> None:
    shared = _skill(tmp_path / "shared", "linked", "Linked skill")
    root = tmp_path / "home" / ".claude" / "skills"
    root.mkdir(parents=True)
    try:
        (root / "linked").symlink_to(shared.parent, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not available")

    skill = _repository(tmp_path).scan(ALL_ON).effective()["linked"]

    assert skill.location == str(shared.resolve())


def test_assigned_skill_files_form_the_last_layer(tmp_path: Path) -> None:
    assigned = _skill(tmp_path / "legacy" / "skills", "local", "Assigned", "Read references/taxes.md")
    _skill(tmp_path / "work" / ".rind" / "skills", "local", "Project")
    repository = _repository(tmp_path, skill_files=(str(assigned),))

    loaded = repository.load_skill("LOCAL", ALL_ON)

    assert loaded.metadata.source == "agent"
    assert loaded.metadata.location == str(assigned.resolve())
    assert loaded.body == "Read references/taxes.md"


def test_catalog_lists_locations_and_the_read_file_rule() -> None:
    catalog = render_available_skills([{"name": "pdf", "description": "Forms & more", "location": "/s/pdf/SKILL.md"}])
    assert "read its file with read_file" in catalog
    assert '<skill name="pdf" location="/s/pdf/SKILL.md">Forms &amp; more</skill>' in catalog
