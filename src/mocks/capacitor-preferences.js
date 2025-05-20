// Mock implementation of @capacitor/preferences for server-side use
export const Preferences = {
  data: new Map(),
  
  async get(options) {
    return { value: this.data.get(options.key) || null };
  },
  
  async set(options) {
    this.data.set(options.key, options.value);
  },
  
  async remove(options) {
    this.data.delete(options.key);
  },
  
  async clear() {
    this.data.clear();
  }
};

export default { Preferences };
