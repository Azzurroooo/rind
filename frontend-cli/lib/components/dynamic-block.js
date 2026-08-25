export class DynamicBlock {
  constructor(build) {
    this.build = build;
    this.cacheWidth = -1;
    this.cacheLines = null;
  }

  render(width) {
    if (this.cacheWidth !== width || this.cacheLines === null) {
      const built = this.build(width);
      this.cacheLines = Array.isArray(built) ? built : [];
      this.cacheWidth = width;
    }
    return this.cacheLines;
  }

  invalidate() {
    this.cacheLines = null;
  }
}
