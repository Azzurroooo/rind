import { escapeAttribute, escapeHtml } from "./app/html.ts"

const CHEVRON_DOWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-select-chevron" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>`

const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="settings-select-check-icon" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`

export type CustomSelectOption = {
  value: string
  label: string
  badge?: string
  mono?: boolean
  disabled?: boolean
}

export type CustomSelectConfig = {
  id?: string
  name?: string
  value?: string
  options: readonly CustomSelectOption[]
  ariaLabel?: string
  disabled?: boolean
  sm?: boolean
  mono?: boolean
  dataAttrs?: Record<string, string>
}

function renderTriggerInnerHtml(label: string, badge?: string, mono?: boolean): string {
  const badgeHtml = badge ? `<span class="settings-select-badge">${escapeHtml(badge)}</span>` : ""
  const labelClass = mono ? "settings-select-trigger-label is-mono" : "settings-select-trigger-label"
  return `
    <span class="settings-select-trigger-content">
      <span class="${labelClass}">${escapeHtml(label)}</span>
      ${badgeHtml}
    </span>
    ${CHEVRON_DOWN_SVG}
  `
}

function renderOptionsInnerHtml(
  options: readonly CustomSelectOption[],
  activeValue: string,
  defaultMono?: boolean,
): string {
  return options
    .map((opt) => {
      const selected = opt.value === activeValue
      const isMono = Boolean(opt.mono || defaultMono)
      const badgeHtml = opt.badge ? `<span class="settings-select-badge">${escapeHtml(opt.badge)}</span>` : ""
      const labelClass = isMono ? "settings-select-option-label is-mono" : "settings-select-option-label"
      const checkHtml = selected ? CHECK_SVG : ""
      return `
        <button type="button" role="option" class="settings-select-option${selected ? " is-selected" : ""}" aria-selected="${selected}" data-custom-select-option="${escapeAttribute(opt.value)}" data-option-label="${escapeAttribute(opt.label)}"${opt.badge ? ` data-option-badge="${escapeAttribute(opt.badge)}"` : ""}${isMono ? ` data-option-mono="1"` : ""}${opt.disabled ? " disabled" : ""}>
          <span class="settings-select-option-content">
            <span class="${labelClass}">${escapeHtml(opt.label)}</span>
            ${badgeHtml}
          </span>
          <span class="settings-select-check" aria-hidden="true">${checkHtml}</span>
        </button>
      `
    })
    .join("")
}

export function renderCustomSelectHtml(opts: CustomSelectConfig): string {
  const activeOpt =
    opts.options.find((o) => o.value === (opts.value ?? "")) ??
    opts.options[0] ?? { value: opts.value ?? "", label: opts.value ?? "" }
  const activeValue = activeOpt.value
  const activeLabel = activeOpt.label || activeValue || "—"
  const isMono = Boolean(activeOpt.mono || opts.mono)

  const idAttr = opts.id ? ` id="${escapeAttribute(opts.id)}"` : ""
  const nameAttr = opts.name ? ` name="${escapeAttribute(opts.name)}"` : ""
  const ariaLabelAttr = opts.ariaLabel ? ` aria-label="${escapeAttribute(opts.ariaLabel)}"` : ""
  const disabledAttr = opts.disabled ? " disabled" : ""
  const dataAttrStr = opts.dataAttrs
    ? Object.entries(opts.dataAttrs)
        .map(([k, v]) => ` data-${k}="${escapeAttribute(v)}"`)
        .join("")
    : ""

  return `<div class="settings-select${opts.sm ? " sm" : ""}" data-custom-select="1"><input type="hidden"${idAttr}${nameAttr}${dataAttrStr} value="${escapeAttribute(activeValue)}" data-custom-select-input="1" /><button type="button" class="settings-select-trigger" data-custom-select-trigger="1" aria-haspopup="listbox" aria-expanded="false"${ariaLabelAttr}${disabledAttr}>${renderTriggerInnerHtml(activeLabel, activeOpt.badge, isMono)}</button><div class="settings-select-menu panel-scroll" role="listbox"${ariaLabelAttr} hidden>${renderOptionsInnerHtml(opts.options, activeValue, opts.mono)}</div></div>`
}

export function setCustomSelectOptions(
  inputId: string,
  options: readonly CustomSelectOption[],
  preferredValue?: string,
): void {
  const input = document.getElementById(inputId) as HTMLInputElement | null
  const root = input?.closest<HTMLElement>("[data-custom-select]")
  if (!input || !root) return

  const desired = preferredValue ?? input.value
  const activeOpt =
    options.find((o) => o.value === desired) ??
    options[0] ?? { value: "", label: "—" }
  input.value = activeOpt.value

  const trigger = root.querySelector<HTMLButtonElement>("[data-custom-select-trigger]")
  const menu = root.querySelector<HTMLElement>(".settings-select-menu")
  if (trigger) {
    trigger.innerHTML = renderTriggerInnerHtml(activeOpt.label || activeOpt.value || "—", activeOpt.badge, activeOpt.mono)
  }
  if (menu) {
    menu.innerHTML = renderOptionsInnerHtml(options, activeOpt.value)
  }
}

export function closeAllCustomSelects(exceptRoot?: HTMLElement | null): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-custom-select].is-open")) {
    if (exceptRoot && root === exceptRoot) continue
    root.classList.remove("is-open")
    const trigger = root.querySelector<HTMLButtonElement>("[data-custom-select-trigger]")
    const menu = root.querySelector<HTMLElement>(".settings-select-menu")
    trigger?.setAttribute("aria-expanded", "false")
    if (menu) menu.hidden = true
  }
}

let customSelectsBound = false

export function bindCustomSelects(): void {
  if (customSelectsBound) return
  customSelectsBound = true

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) {
      closeAllCustomSelects()
      return
    }

    const optionBtn = target.closest<HTMLButtonElement>("[data-custom-select-option]")
    if (optionBtn) {
      event.preventDefault()
      if (optionBtn.disabled) return
      const root = optionBtn.closest<HTMLElement>("[data-custom-select]")
      if (!root) return
      const nextValue = optionBtn.dataset.customSelectOption ?? ""
      const nextLabel = optionBtn.dataset.optionLabel ?? nextValue
      const nextBadge = optionBtn.dataset.optionBadge
      const nextMono = optionBtn.dataset.optionMono === "1"

      const input = root.querySelector<HTMLInputElement>("[data-custom-select-input]")
      const trigger = root.querySelector<HTMLButtonElement>("[data-custom-select-trigger]")
      const menu = root.querySelector<HTMLElement>(".settings-select-menu")
      const changed = input ? input.value !== nextValue : true

      if (input) {
        input.value = nextValue
      }
      if (trigger) {
        trigger.innerHTML = renderTriggerInnerHtml(nextLabel || "—", nextBadge, nextMono)
        trigger.setAttribute("aria-expanded", "false")
      }
      if (menu) {
        for (const opt of menu.querySelectorAll<HTMLButtonElement>("[data-custom-select-option]")) {
          const isSelected = (opt.dataset.customSelectOption ?? "") === nextValue
          opt.classList.toggle("is-selected", isSelected)
          opt.setAttribute("aria-selected", String(isSelected))
          const check = opt.querySelector<HTMLElement>(".settings-select-check")
          if (check) {
            check.innerHTML = isSelected ? CHECK_SVG : ""
          }
        }
        menu.hidden = true
      }
      root.classList.remove("is-open")

      if (input && changed) {
        input.dispatchEvent(new Event("change", { bubbles: true }))
      }
      return
    }

    const triggerBtn = target.closest<HTMLButtonElement>("[data-custom-select-trigger]")
    if (triggerBtn) {
      event.preventDefault()
      if (triggerBtn.disabled) return
      const root = triggerBtn.closest<HTMLElement>("[data-custom-select]")
      if (!root) return
      const menu = root.querySelector<HTMLElement>(".settings-select-menu")
      const nextOpen = !root.classList.contains("is-open")
      closeAllCustomSelects(root)
      root.classList.toggle("is-open", nextOpen)
      triggerBtn.setAttribute("aria-expanded", String(nextOpen))
      if (menu) menu.hidden = !nextOpen
      return
    }

    if (!target.closest("[data-custom-select]")) {
      closeAllCustomSelects()
    }
  })

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        const openSelect = document.querySelector<HTMLElement>("[data-custom-select].is-open")
        if (openSelect) {
          event.stopPropagation()
          const trigger = openSelect.querySelector<HTMLButtonElement>("[data-custom-select-trigger]")
          closeAllCustomSelects()
          trigger?.focus()
        }
      }
    },
    true,
  )
}
