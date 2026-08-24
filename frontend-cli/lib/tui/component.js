export class Component {
  render(width) {
    return [];
  }

  invalidate() {}
}

export class Container extends Component {
  constructor() {
    super();
    this.children = [];
  }

  addChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
  }

  clear() {
    this.children.length = 0;
  }

  get length() {
    return this.children.length;
  }

  render(width) {
    const lines = [];
    for (const child of this.children) {
      const rendered = child.render(width);
      if (Array.isArray(rendered)) {
        for (const line of rendered) {
          lines.push(typeof line === "string" ? line : String(line ?? ""));
        }
      }
    }
    return lines;
  }

  invalidate() {
    for (const child of this.children) {
      if (typeof child.invalidate === "function") {
        child.invalidate();
      }
    }
  }
}
