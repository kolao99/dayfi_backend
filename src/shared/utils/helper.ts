class Helper {
  static async capitalize(string: string): Promise<string> {
    return string.charAt(0).toUpperCase() + string.slice(1);
  }

  static async snakeToCamelCase(obj: any): Promise<any> {
    if (obj instanceof Date) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return Promise.all(obj.map((item) => this.snakeToCamelCase(item)));
    } else if (obj && typeof obj === 'object' && obj.constructor === Object) {
      const result: any = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
            letter.toUpperCase()
          );
          result[camelKey] = await this.snakeToCamelCase(obj[key]);
        }
      }
      return result;
    }

    return obj;
  }
}

export default Helper;
