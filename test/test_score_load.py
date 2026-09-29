import pytest

from score_load import BUDGETS, score, score_report


def example():
    """Synthetic inputs for arithmetic/qualification tests, not benchmark data."""
    return {
        "level": "L3", "correctness_passed": True,
        "manifest": {"os": "windows", "interactive": True, "tty": True,
                     "visible": True, "foreground": True, "ui_verified": True,
                     "product_sha": "synthetic", "command": "interactive command",
                     "terminal": "test", "fixture_sha256": "synthetic",
                     "ui_evidence": "synthetic", "raw_samples": "synthetic"},
        "scenarios": {f"C{index:02}": {
            "trials": 30, "cpu_ms": 0, "cpu_core_percent": 0,
            "output_bytes": 0, "output_bytes_per_second": 0,
            "private_bytes_p95": 0, "private_bytes_peak": 0,
            "first_input_ms": 0, "input_p95_ms": 0, "input_p99_ms": 0,
            "stream_p95_ms": 0, "tail_ms": 0, "cancel_p95_ms": 0,
        } for index in range(1, 11)},
    }


def test_budgets_and_arithmetic():
    assert sum(budget[0] for budget in BUDGETS) == 100
    assert score(0, 20, 100) == 100
    assert score(60, 20, 100) == 50
    assert score(200, 20, 100) == 0
    report = example()
    assert score_report(report)["total"] == 100
    report["scenarios"]["C05"]["cpu_core_percent"] = 30
    assert score_report(report)["total"] == pytest.approx(93.6)


@pytest.mark.parametrize("change", [
    lambda r: r.update(level="L1"),
    lambda r: r["manifest"].update(tty=False),
    lambda r: r["manifest"].update(visible=False),
    lambda r: r["manifest"].update(interactive=False),
    lambda r: r["scenarios"].pop("C10"),
    lambda r: r.update(correctness_passed=False),
    lambda r: r["scenarios"]["C01"].update(trials=5),
    lambda r: r["scenarios"]["C05"].update(input_p95_ms=51, input_p99_ms=60),
    lambda r: r["scenarios"]["C05"].update(cpu_core_percent=float("nan")),
    lambda r: r["scenarios"]["C05"].update(private_bytes_peak=True),
    lambda r: r["scenarios"]["C05"].update(tail_ms=151),
    lambda r: r["scenarios"]["C05"].update(cancel_p95_ms=151),
])
def test_invalid_or_incomplete_results_never_receive_a_score(change):
    report = example()
    change(report)
    with pytest.raises(ValueError):
        score_report(report)
