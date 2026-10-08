"""Folder defaults: what a new conversation in a folder starts with."""

from __future__ import annotations

import json
import subprocess

import pytest

from agent.domain.models import ModelSelection
from agent.infrastructure.workspace_defaults import WorkspaceDefaults, main_repository

SETTINGS = ModelSelection("deepseek", "deepseek-flash", "low")


@pytest.fixture
def defaults(tmp_path):
    return WorkspaceDefaults(tmp_path / "home" / "workspaces.json")


def _folder(tmp_path, name):
    path = tmp_path / name
    path.mkdir()
    return str(path)


def test_without_folder_defaults_settings_json_decides(defaults, tmp_path):
    resolved = defaults.resolve(_folder(tmp_path, "plain"), SETTINGS)
    assert (resolved.selection, resolved.model_source, resolved.effort_source) == (SETTINGS, "settings", "settings")


def test_the_model_and_the_effort_are_set_and_inherited_independently(defaults, tmp_path):
    folder = _folder(tmp_path, "project")
    defaults.set_reasoning_effort(folder, "high")
    only_effort = defaults.resolve(folder, SETTINGS)
    assert only_effort.selection == ModelSelection("deepseek", "deepseek-flash", "high")
    assert (only_effort.model_source, only_effort.effort_source) == ("settings", "folder")

    defaults.set_model(folder, "openai", "gpt-5.5")
    both = defaults.resolve(folder, SETTINGS)
    assert both.selection == ModelSelection("openai", "gpt-5.5", "high")
    assert (both.model_source, both.effort_source) == ("folder", "folder")


def test_unsetting_one_group_keeps_the_other(defaults, tmp_path):
    folder = _folder(tmp_path, "project")
    defaults.set_model(folder, "openai", "gpt-5.5")
    defaults.set_reasoning_effort(folder, "high")

    assert defaults.unset(folder, "model") is True
    assert defaults.get(folder) == {"reasoning_effort": "high"}
    assert defaults.unset(folder, "model") is False
    assert defaults.unset(folder, "reasoning_effort") is True
    assert json.loads(defaults.path.read_text(encoding="utf-8")) == {}, "an emptied folder leaves no entry"


def test_defaults_are_kept_by_the_real_path_not_the_spelling(defaults, tmp_path):
    folder = _folder(tmp_path, "project")
    defaults.set_model(folder, "openai", "gpt-5.5")
    assert defaults.get(folder + "/sub/..")["model"] == "gpt-5.5"


def test_a_folder_default_model_needs_its_connection_and_a_valid_effort(defaults, tmp_path):
    folder = _folder(tmp_path, "project")
    with pytest.raises(ValueError):
        defaults.set_model(folder, "", "gpt-5.5")
    with pytest.raises(ValueError):
        defaults.set_reasoning_effort(folder, "extreme")
    assert not defaults.path.exists()


def _git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def worktree(tmp_path):
    main = tmp_path / "main"
    main.mkdir()
    _git("init", "-q", cwd=main)
    _git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init", cwd=main)
    _git("worktree", "add", "-q", str(tmp_path / "feature"), cwd=main)
    return main, tmp_path / "feature"


def test_a_worktree_finds_its_main_repository(worktree):
    main, feature = worktree
    assert main_repository(str(feature)) == main.resolve()
    assert main_repository(str(main)) is None, "the main checkout has a .git directory, not a file"


def test_a_worktree_uses_the_main_repository_defaults_until_it_sets_its_own(defaults, worktree):
    main, feature = worktree
    defaults.set_model(str(main), "openai", "gpt-5.5")
    defaults.set_reasoning_effort(str(main), "high")
    inherited = defaults.resolve(str(feature), SETTINGS)
    assert inherited.selection == ModelSelection("openai", "gpt-5.5", "high")
    assert (inherited.model_source, inherited.effort_source) == ("main_repository", "main_repository")

    defaults.set_reasoning_effort(str(feature), "low")
    own = defaults.resolve(str(feature), SETTINGS)
    assert own.selection.reasoning_effort == "low" and own.effort_source == "folder"
    assert own.model_source == "main_repository"
    cleared = defaults.resolve(str(feature), SETTINGS, own=False)
    assert (cleared.selection.reasoning_effort, cleared.effort_source) == ("high", "main_repository")
