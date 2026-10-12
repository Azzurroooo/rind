import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT_ROOT)
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from agent.domain.skills import IMPORT_SOURCES, parse_skill_metadata, render_available_skills
from agent.infrastructure.skills import SkillRepository, install_system_skills

ALL_ON = dict.fromkeys(IMPORT_SOURCES, True)


def _write(root: Path, folder: str, frontmatter: str, body: str = "Body") -> Path:
    skill_file = root / folder / "SKILL.md"
    skill_file.parent.mkdir(parents=True, exist_ok=True)
    skill_file.write_text(f"---\n{frontmatter}\n---\n\n{body}\n", encoding="utf-8")
    return skill_file


def _skill(root: Path, name: str, description: str, body: str = "Body") -> Path:
    return _write(root, name, f"name: {name}\ndescription: {description}", body)


def _repository(tmp_path: Path, **kwargs) -> SkillRepository:
    install_system_skills(tmp_path / "rind")
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


def _bundle(root: Path, **files: str) -> Path:
    for relative, text in files.items():
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        (root / relative).write_text(text, encoding="utf-8")
    return root


def test_system_skills_are_installed_once_and_left_alone_while_unchanged(tmp_path: Path, monkeypatch) -> None:
    bundled = _bundle(tmp_path / "bundle", **{"tool/SKILL.md": "---\ndescription: Tool\n---\n"})
    install_system_skills(tmp_path / "rind", bundled)
    monkeypatch.setattr("agent.infrastructure.skills.shutil.copytree", lambda *args: pytest.fail("unchanged skills must not be copied"))

    install_system_skills(tmp_path / "rind", bundled)

    system = tmp_path / "rind" / "skills" / ".system"
    assert (system / "tool" / "SKILL.md").read_text(encoding="utf-8").startswith("---")
    assert len((system / ".bundle").read_text(encoding="utf-8")) == 64


def test_an_update_replaces_the_whole_copy_and_clears_leftovers(tmp_path: Path) -> None:
    rind = tmp_path / "rind"
    old = _bundle(tmp_path / "old", **{"gone/SKILL.md": "---\ndescription: Gone\n---\n"})
    new = _bundle(tmp_path / "new", **{"kept/SKILL.md": "---\ndescription: Kept\n---\n"})
    install_system_skills(rind, old)
    (rind / "skills" / ".system-crashed").mkdir()

    install_system_skills(rind, new)

    assert [path.name for path in (rind / "skills").glob(".system-*")] == []
    assert sorted(path.name for path in (rind / "skills" / ".system").iterdir()) == [".bundle", "kept"]


def test_concurrent_installs_leave_one_complete_copy(tmp_path: Path) -> None:
    from concurrent.futures import ThreadPoolExecutor

    bundled = _bundle(tmp_path / "bundle", **{f"s{index}/SKILL.md": f"---\ndescription: S{index}\n---\n" for index in range(20)})
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda _index: install_system_skills(tmp_path / "rind", bundled), range(8)))

    system = tmp_path / "rind" / "skills" / ".system"
    assert len([path for path in system.iterdir() if path.is_dir()]) == 20
    assert [path.name for path in (tmp_path / "rind" / "skills").glob(".system-*")] == []


def test_a_missing_bundle_keeps_the_installed_copy_and_raises(tmp_path: Path) -> None:
    install_system_skills(tmp_path / "rind", _bundle(tmp_path / "bundle", **{"tool/SKILL.md": "---\ndescription: Tool\n---\n"}))

    with pytest.raises(OSError):
        install_system_skills(tmp_path / "rind", tmp_path / "absent")

    assert (tmp_path / "rind" / "skills" / ".system" / "tool" / "SKILL.md").is_file()


def test_built_in_skills_come_from_the_system_copy_and_are_reported_when_missing(tmp_path: Path) -> None:
    missing = SkillRepository(tmp_path / "work", home=tmp_path / "home", rind_home=tmp_path / "rind").scan(ALL_ON)
    builtin = next(scanned for scanned in missing.sources if scanned.source.id == "builtin")
    assert [problem.message for problem in builtin.problems] == ["built-in skills are missing; restart Rind or reinstall it."]

    scan = _repository(tmp_path).scan(ALL_ON)
    by_id = {scanned.source.id: scanned for scanned in scan.sources}
    assert scan.effective()["skill-creator"].location == str((tmp_path / "rind" / "skills" / ".system" / "skill-creator" / "SKILL.md").resolve())
    assert by_id["builtin"].problems == ()
    assert by_id["rind_user"].skills == (), "the user layer never lists .system again"
