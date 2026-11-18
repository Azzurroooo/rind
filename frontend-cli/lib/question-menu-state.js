export const CUSTOM_ANSWER_LABEL = "Type your own answer";

export function createQuestionMenuState(input) {
  const questions = normalizeQuestionList(input);
  let activeStep = 0;
  let editing = false;

  const steps = questions.map((q) => ({
    selected: 0,
    picked: new Set(),
    customSelected: false,
    customText: "",
    options: q.options,
    multiple: Boolean(q.multiple),
    header: q.header || "",
    question: q.question || "",
  }));

  const current = () => steps[activeStep] || {
    selected: 0,
    picked: new Set(),
    customSelected: false,
    customText: "",
    options: [],
    multiple: false,
    header: "",
    question: "",
  };

  function stepAnswers(index = activeStep) {
    const step = steps[index];
    if (!step) return [];
    const custom = step.customText.trim();
    if (step.multiple) {
      const base = [...step.picked]
        .sort((a, b) => a - b)
        .map((i) => step.options[i]?.label)
        .filter(Boolean);
      return step.customSelected && custom ? [...base, custom] : base;
    }
    if (step.customSelected) {
      return custom ? [custom] : [];
    }
    if (step.picked.size > 0) {
      const idx = [...step.picked][0];
      const label = step.options[idx]?.label;
      return label ? [label] : [];
    }
    return [];
  }

  function findNextUnanswered(fromIndex = activeStep) {
    for (let offset = 1; offset < steps.length; offset += 1) {
      const idx = (fromIndex + offset) % steps.length;
      if (stepAnswers(idx).length === 0) return idx;
    }
    return -1;
  }

  return {
    questionCount() {
      return steps.length;
    },
    activeStep() {
      return activeStep;
    },
    currentQuestion() {
      const step = current();
      return {
        header: step.header,
        question: step.question,
        multiple: step.multiple,
        options: step.options,
      };
    },
    stepSummary() {
      return steps.map((step, idx) => ({
        index: idx,
        label: step.header || `Q${idx + 1}`,
        question: step.question,
        done: stepAnswers(idx).length > 0,
        active: idx === activeStep,
      }));
    },
    options() {
      return current().options;
    },
    multiple() {
      return current().multiple;
    },
    selectedIndex() {
      return current().selected;
    },
    selectedOption() {
      const step = current();
      return step.options[step.selected] || null;
    },
    pickedIndices() {
      return [...current().picked];
    },
    isOptionPicked(index) {
      const step = current();
      if (index === step.options.length) return step.customSelected;
      return step.picked.has(index);
    },
    customText() {
      return current().customText;
    },
    setCustomText(value, markSelected = true) {
      const step = current();
      step.customText = String(value || "");
      if (markSelected) {
        if (!step.multiple) step.picked.clear();
        step.customSelected = Boolean(step.customText.trim());
      }
    },
    isEditing() {
      return editing;
    },
    enterEditing() {
      const step = current();
      if (step.selected !== step.options.length) {
        return false;
      }
      editing = true;
      return true;
    },
    leaveEditing() {
      if (!editing) {
        return false;
      }
      editing = false;
      return true;
    },
    stepBy(delta) {
      if (editing || steps.length <= 1) return false;
      activeStep = (activeStep + delta + steps.length) % steps.length;
      return true;
    },
    toggleCurrent() {
      if (editing) return "none";
      const step = current();
      if (step.selected === step.options.length) {
        if (step.customText.trim() && step.customSelected) {
          step.customSelected = false;
          return "toggled";
        }
        editing = true;
        return "edit";
      }
      if (!step.multiple) {
        step.picked.clear();
        step.picked.add(step.selected);
        step.customSelected = false;
        return "toggled";
      }
      if (step.picked.has(step.selected)) {
        step.picked.delete(step.selected);
      } else {
        step.picked.add(step.selected);
      }
      return "toggled";
    },
    confirmCurrent(customInputValue = null) {
      const step = current();
      if (customInputValue !== null) {
        const trimmed = String(customInputValue || "").trim();
        if (!trimmed) return { done: false, switched: false };
        step.customText = trimmed;
        if (!step.multiple) step.picked.clear();
        step.customSelected = true;
        editing = false;
      } else if (step.selected === step.options.length) {
        if (!step.customText.trim()) {
          editing = true;
          return { done: false, editing: true };
        }
        if (!step.multiple) step.picked.clear();
        step.customSelected = true;
      } else if (step.multiple) {
        if (stepAnswers(activeStep).length === 0) {
          step.picked.add(step.selected);
        }
      } else {
        step.picked.clear();
        step.picked.add(step.selected);
        step.customSelected = false;
      }

      const nextUnanswered = findNextUnanswered(activeStep);
      if (nextUnanswered !== -1) {
        activeStep = nextUnanswered;
        return { done: false, switched: true };
      }
      if (steps.length > 1 && activeStep < steps.length - 1) {
        activeStep += 1;
        return { done: false, switched: true };
      }
      const all = steps.map((_, idx) => stepAnswers(idx));
      if (all.every((ans) => ans.length > 0)) {
        return { done: true, answers: all };
      }
      return { done: false, switched: false };
    },
    handleNavigation(key = {}) {
      if (editing) {
        return false;
      }
      if ((key.name === "left" || key.name === "right") && steps.length > 1) {
        return this.stepBy(key.name === "left" ? -1 : 1);
      }
      const vimNavigation = !editing && (key.text === "j" || key.text === "k");
      if (key.name !== "up" && key.name !== "down" && !vimNavigation) {
        return false;
      }
      const step = current();
      const total = step.options.length + 1;
      if (key.name === "up" || key.text === "k") {
        step.selected = step.selected <= 0 ? total - 1 : step.selected - 1;
      } else {
        step.selected = step.selected >= total - 1 ? 0 : step.selected + 1;
      }
      editing = false;
      return true;
    },
  };
}

function normalizeQuestionList(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 0 && list[0] && typeof list[0] === "object" && "question" in list[0]) {
    const normalized = list
      .map((q) => ({
        header: String(q?.header || "").trim(),
        question: String(q?.question || "").trim(),
        multiple: Boolean(q?.multiple),
        options: normalizeOptions(q?.options),
      }))
      .filter((q) => q.question || q.options.length > 0);
    return normalized.length > 0 ? normalized : [{ header: "", question: "Input required", multiple: false, options: [] }];
  }
  return [{ header: "", question: "", multiple: false, options: normalizeOptions(list) }];
}

function normalizeOptions(options) {
  const labels = new Set();
  const items = [];
  for (const option of Array.isArray(options) ? options : []) {
    const label = String(option?.label || "").trim();
    if (!label || labels.has(label)) {
      continue;
    }
    labels.add(label);
    items.push({
      label,
      description: String(option?.description || "").trim(),
    });
  }
  return items;
}
