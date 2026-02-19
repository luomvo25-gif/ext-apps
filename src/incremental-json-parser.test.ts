import { describe, it, expect, beforeEach } from "bun:test";
import { IncrementalJsonParser } from "./incremental-json-parser";

describe("IncrementalJsonParser", () => {
  let parser: IncrementalJsonParser;

  beforeEach(() => {
    parser = new IncrementalJsonParser();
  });

  // -----------------------------------------------------------------------
  // Basic healing — objects
  // -----------------------------------------------------------------------

  describe("objects", () => {
    it("heals empty input to empty string", () => {
      expect(parser.getHealed()).toBe("");
    });

    it("heals opening brace", () => {
      parser.write("{");
      expect(parser.getHealed()).toBe("{}");
    });

    it("heals partial key", () => {
      parser.write('{"na');
      expect(parser.getHealed()).toBe('{"na": null}');
    });

    it("heals complete key without colon", () => {
      parser.write('{"name"');
      expect(parser.getHealed()).toBe('{"name": null}');
    });

    it("heals after colon", () => {
      parser.write('{"name":');
      expect(parser.getHealed()).toBe('{"name":null}');
    });

    it("heals after colon with space", () => {
      parser.write('{"name": ');
      expect(parser.getHealed()).toBe('{"name": null}');
    });

    it("heals partial string value", () => {
      parser.write('{"name": "Ali');
      expect(parser.getHealed()).toBe('{"name": "Ali"}');
    });

    it("passes through complete object", () => {
      parser.write('{"name": "Alice"}');
      expect(parser.getHealed()).toBe('{"name": "Alice"}');
      expect(parser.isComplete).toBe(true);
    });

    it("heals trailing comma in object", () => {
      parser.write('{"a": 1,');
      expect(parser.getHealed()).toBe('{"a": 1}');
    });

    it("heals trailing comma with space in object", () => {
      parser.write('{"a": 1, ');
      expect(parser.getHealed()).toBe('{"a": 1}');
    });

    it("heals multi-key object mid-value", () => {
      parser.write('{"a": 1, "b": "hel');
      expect(parser.getHealed()).toBe('{"a": 1, "b": "hel"}');
    });

    it("heals object with complete second pair", () => {
      parser.write('{"a": 1, "b": 2');
      expect(parser.getHealed()).toBe('{"a": 1, "b": 2}');
    });
  });

  // -----------------------------------------------------------------------
  // Basic healing — arrays
  // -----------------------------------------------------------------------

  describe("arrays", () => {
    it("heals opening bracket", () => {
      parser.write("[");
      expect(parser.getHealed()).toBe("[]");
    });

    it("heals array with one element", () => {
      parser.write("[1");
      expect(parser.getHealed()).toBe("[1]");
    });

    it("heals array trailing comma", () => {
      parser.write("[1,");
      expect(parser.getHealed()).toBe("[1]");
    });

    it("heals array trailing comma with space", () => {
      parser.write("[1, ");
      expect(parser.getHealed()).toBe("[1]");
    });

    it("heals array with partial string", () => {
      parser.write('["hel');
      expect(parser.getHealed()).toBe('["hel"]');
    });

    it("passes through complete array", () => {
      parser.write("[1, 2, 3]");
      expect(parser.getHealed()).toBe("[1, 2, 3]");
      expect(parser.isComplete).toBe(true);
    });

    it("heals mixed-type array", () => {
      parser.write('[1, "two", tru');
      expect(parser.getHealed()).toBe('[1, "two", true]');
    });
  });

  // -----------------------------------------------------------------------
  // Nesting
  // -----------------------------------------------------------------------

  describe("nesting", () => {
    it("heals nested object", () => {
      parser.write('{"a": {"b": "c');
      expect(parser.getHealed()).toBe('{"a": {"b": "c"}}');
    });

    it("heals nested array in object", () => {
      parser.write('{"items": [1, 2');
      expect(parser.getHealed()).toBe('{"items": [1, 2]}');
    });

    it("heals nested object in array", () => {
      parser.write('[{"a": 1}, {"b":');
      expect(parser.getHealed()).toBe('[{"a": 1}, {"b":null}]');
    });

    it("heals deeply nested structure", () => {
      parser.write('{"a": {"b": {"c": [1, {"d": "e');
      expect(parser.getHealed()).toBe('{"a": {"b": {"c": [1, {"d": "e"}]}}}');
    });

    it("heals nested trailing commas", () => {
      parser.write("[1, [2, ");
      expect(parser.getHealed()).toBe("[1, [2]]");
    });

    it("heals after nested container closes", () => {
      parser.write('{"a": [1, 2], ');
      expect(parser.getHealed()).toBe('{"a": [1, 2]}');
    });
  });

  // -----------------------------------------------------------------------
  // Strings — escapes
  // -----------------------------------------------------------------------

  describe("string escapes", () => {
    it("heals string with complete escape", () => {
      parser.write('{"a": "line1\\nline2');
      expect(parser.getHealed()).toBe('{"a": "line1\\nline2"}');
    });

    it("heals string ending with backslash", () => {
      parser.write('{"a": "test\\');
      expect(parser.getHealed()).toBe('{"a": "test\\n"}');
    });

    it("heals string with partial unicode escape", () => {
      parser.write('{"a": "\\u00');
      expect(parser.getHealed()).toBe('{"a": "\\u0000"}');
    });

    it("heals string with complete unicode escape", () => {
      parser.write('{"a": "\\u0041');
      expect(parser.getHealed()).toBe('{"a": "\\u0041"}');
    });

    it("heals key string ending with backslash", () => {
      parser.write('{"a\\');
      expect(parser.getHealed()).toBe('{"a\\n": null}');
    });

    it("handles escaped quote in string", () => {
      parser.write('{"a": "say \\"hello');
      expect(parser.getHealed()).toBe('{"a": "say \\"hello"}');
    });

    it("handles escaped backslash in string", () => {
      parser.write('{"a": "path\\\\dir');
      expect(parser.getHealed()).toBe('{"a": "path\\\\dir"}');
    });
  });

  // -----------------------------------------------------------------------
  // Numbers
  // -----------------------------------------------------------------------

  describe("numbers", () => {
    it("heals integer", () => {
      parser.write('{"n": 42');
      expect(parser.getHealed()).toBe('{"n": 42}');
    });

    it("heals negative sign only", () => {
      parser.write('{"n": -');
      expect(parser.getHealed()).toBe('{"n": -0}');
    });

    it("heals zero", () => {
      parser.write('{"n": 0');
      expect(parser.getHealed()).toBe('{"n": 0}');
    });

    it("heals decimal point without digits", () => {
      parser.write('{"n": 1.');
      expect(parser.getHealed()).toBe('{"n": 1.0}');
    });

    it("heals decimal with digits", () => {
      parser.write('{"n": 3.14');
      expect(parser.getHealed()).toBe('{"n": 3.14}');
    });

    it("heals exponent without digits", () => {
      parser.write('{"n": 1e');
      expect(parser.getHealed()).toBe('{"n": 1e0}');
    });

    it("heals exponent sign without digits", () => {
      parser.write('{"n": 1e+');
      expect(parser.getHealed()).toBe('{"n": 1e+0}');
    });

    it("heals exponent with negative sign", () => {
      parser.write('{"n": 1e-');
      expect(parser.getHealed()).toBe('{"n": 1e-0}');
    });

    it("heals complete exponent", () => {
      parser.write('{"n": 1e10');
      expect(parser.getHealed()).toBe('{"n": 1e10}');
    });

    it("heals negative decimal with exponent", () => {
      parser.write('{"n": -3.14e');
      expect(parser.getHealed()).toBe('{"n": -3.14e0}');
    });

    it("terminates number at comma", () => {
      parser.write("[1,2");
      expect(parser.getHealed()).toBe("[1,2]");
    });

    it("terminates number at closing brace", () => {
      parser.write('{"a":1}');
      expect(parser.getHealed()).toBe('{"a":1}');
      expect(parser.isComplete).toBe(true);
    });

    it("terminates number at closing bracket", () => {
      parser.write("[1]");
      expect(parser.getHealed()).toBe("[1]");
      expect(parser.isComplete).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Literals (true, false, null)
  // -----------------------------------------------------------------------

  describe("literals", () => {
    it("heals partial true", () => {
      parser.write('{"a": t');
      expect(parser.getHealed()).toBe('{"a": true}');
    });

    it("heals partial true (tr)", () => {
      parser.write('{"a": tr');
      expect(parser.getHealed()).toBe('{"a": true}');
    });

    it("heals complete true", () => {
      parser.write('{"a": true');
      expect(parser.getHealed()).toBe('{"a": true}');
    });

    it("heals partial false", () => {
      parser.write('{"a": fal');
      expect(parser.getHealed()).toBe('{"a": false}');
    });

    it("heals complete false", () => {
      parser.write('{"a": false');
      expect(parser.getHealed()).toBe('{"a": false}');
    });

    it("heals partial null", () => {
      parser.write('{"a": nu');
      expect(parser.getHealed()).toBe('{"a": null}');
    });

    it("heals complete null", () => {
      parser.write('{"a": null');
      expect(parser.getHealed()).toBe('{"a": null}');
    });

    it("literal followed by comma", () => {
      parser.write('{"a": true, "b": 1');
      expect(parser.getHealed()).toBe('{"a": true, "b": 1}');
    });

    it("literal in array", () => {
      parser.write("[true, fal");
      expect(parser.getHealed()).toBe("[true, false]");
    });
  });

  // -----------------------------------------------------------------------
  // Top-level primitives
  // -----------------------------------------------------------------------

  describe("top-level primitives", () => {
    it("heals top-level string", () => {
      parser.write('"hel');
      expect(parser.getHealed()).toBe('"hel"');
    });

    it("completes top-level string", () => {
      parser.write('"hello"');
      expect(parser.getHealed()).toBe('"hello"');
      expect(parser.isComplete).toBe(true);
    });

    it("heals top-level number", () => {
      parser.write("42");
      expect(parser.getHealed()).toBe("42");
      // Numbers can't self-complete; use end() to signal EOF.
      expect(parser.isComplete).toBe(false);
      parser.end();
      expect(parser.isComplete).toBe(true);
    });

    it("heals top-level true", () => {
      parser.write("tru");
      expect(parser.getHealed()).toBe("true");
    });

    it("completes top-level null", () => {
      parser.write("null");
      expect(parser.getHealed()).toBe("null");
      expect(parser.isComplete).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Incremental write (multiple chunks)
  // -----------------------------------------------------------------------

  describe("incremental write", () => {
    it("builds up object character by character", () => {
      const input = '{"name": "Alice"}';
      for (let i = 0; i < input.length; i++) {
        parser.write(input[i]!);
        const healed = parser.getHealed();
        // Every intermediate step should produce valid JSON.
        expect(() => JSON.parse(healed)).not.toThrow();
      }
      expect(parser.isComplete).toBe(true);
      expect(parser.getHealed()).toBe(input);
    });

    it("handles multi-character chunks", () => {
      parser.write('{"na');
      parser.write('me": ');
      parser.write('"Ali');
      parser.write('ce"}');
      expect(parser.getHealed()).toBe('{"name": "Alice"}');
      expect(parser.isComplete).toBe(true);
    });

    it("heals correctly at every intermediate step", () => {
      const steps = [
        ['{"lo', '{"lo": null}'],
        ['cation": "N', '{"location": "N"}'],
        ["ew Yor", '{"location": "New Yor"}'],
        ['k", "units": "met', '{"location": "New York", "units": "met"}'],
        ['ric"}', '{"location": "New York", "units": "metric"}'],
      ] as const;

      for (const [chunk, expected] of steps) {
        parser.write(chunk);
        expect(parser.getHealed()).toBe(expected);
      }
    });

    it("ignores empty writes", () => {
      parser.write('{"a": 1');
      const healed1 = parser.getHealed();
      parser.write("");
      expect(parser.getHealed()).toBe(healed1);
    });

    it("ignores writes after completion", () => {
      parser.write('{"a": 1}');
      expect(parser.isComplete).toBe(true);
      parser.write('{"b": 2}');
      expect(parser.getHealed()).toBe('{"a": 1}');
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe("events", () => {
    it("fires onUpdate on each write", () => {
      const updates: string[] = [];
      parser.onUpdate = (healed) => updates.push(healed);

      parser.write("{");
      parser.write('"a');
      parser.write('": 1}');

      expect(updates).toEqual(["{}", '{"a": null}', '{"a": 1}']);
    });

    it("fires onComplete when JSON is finished", () => {
      const results: string[] = [];
      parser.onComplete = (json) => {
        results.push(json);
      };

      parser.write('{"a": ');
      expect(results).toEqual([]);

      parser.write("1}");
      expect(results).toEqual(['{"a": 1}']);
    });

    it("does not fire onUpdate for empty writes", () => {
      const updates: string[] = [];
      parser.onUpdate = (healed) => updates.push(healed);

      parser.write("");
      expect(updates).toEqual([]);
    });

    it("supports constructor callbacks", () => {
      const updates: string[] = [];
      const completions: string[] = [];

      const p = new IncrementalJsonParser({
        onUpdate: (h) => updates.push(h),
        onComplete: (j) => completions.push(j),
      });

      p.write('{"x": 1}');
      expect(updates).toEqual(['{"x": 1}']);
      expect(completions).toEqual(['{"x": 1}']);
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("resets parser to initial state", () => {
      parser.write('{"a": 1');
      expect(parser.getHealed()).toBe('{"a": 1}');

      parser.reset();
      expect(parser.getHealed()).toBe("");
      expect(parser.isComplete).toBe(false);
      expect(parser.getRaw()).toBe("");
    });

    it("can parse new input after reset", () => {
      parser.write('{"a": 1}');
      expect(parser.isComplete).toBe(true);

      parser.reset();
      parser.write('{"b": 2}');
      expect(parser.getHealed()).toBe('{"b": 2}');
      expect(parser.isComplete).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Caching
  // -----------------------------------------------------------------------

  describe("caching", () => {
    it("returns cached result for repeated getHealed calls", () => {
      parser.write('{"a": 1');
      const h1 = parser.getHealed();
      const h2 = parser.getHealed();
      expect(h1).toBe(h2);
    });

    it("invalidates cache on write", () => {
      parser.write('{"a": 1');
      const h1 = parser.getHealed();
      parser.write(', "b": 2');
      const h2 = parser.getHealed();
      expect(h1).not.toBe(h2);
      expect(h2).toBe('{"a": 1, "b": 2}');
    });
  });

  // -----------------------------------------------------------------------
  // Properties
  // -----------------------------------------------------------------------

  describe("properties", () => {
    it("tracks depth", () => {
      expect(parser.depth).toBe(0);
      parser.write("{");
      expect(parser.depth).toBe(1);
      parser.write('"a": [');
      expect(parser.depth).toBe(2);
      parser.write("1]");
      expect(parser.depth).toBe(1);
      parser.write("}");
      expect(parser.depth).toBe(0);
    });

    it("tracks raw input", () => {
      parser.write('{"a": ');
      parser.write("1");
      expect(parser.getRaw()).toBe('{"a": 1');
    });
  });

  // -----------------------------------------------------------------------
  // All healed outputs produce valid JSON
  // -----------------------------------------------------------------------

  describe("all healed outputs are valid JSON", () => {
    const testCases: string[] = [
      '{"location": "New York", "units": "metric"}',
      '[1, "two", true, null, {"nested": [3.14, false]}]',
      '{"a": {"b": {"c": {"d": "deep"}}}}',
      '"simple string"',
      "42",
      "true",
      "null",
      '{"escape": "line1\\nline2\\ttab\\u0041"}',
      '{"numbers": [-1, 0, 3.14, 1e10, -2.5e-3]}',
      "[[], {}, [[1, 2], [3, 4]]]",
      '{"empty": {}, "also_empty": []}',
    ];

    for (const input of testCases) {
      it(`valid at every byte for: ${input.substring(0, 50)}…`, () => {
        const p = new IncrementalJsonParser();
        for (let i = 0; i < input.length; i++) {
          p.write(input[i]!);
          const healed = p.getHealed();
          expect(() => JSON.parse(healed)).not.toThrow();
        }
        // Signal end-of-input (needed for top-level numbers that can't
        // self-terminate).
        p.end();
        // Final result should match the original input.
        expect(p.getHealed()).toBe(input);
        expect(p.isComplete).toBe(true);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Healed output matches JSON.parse round-trip
  // -----------------------------------------------------------------------

  describe("healed output round-trips through JSON.parse", () => {
    it("incomplete object heals to parseable JSON", () => {
      parser.write('{"name": "Alice", "age": 3');
      const healed = parser.getHealed();
      const parsed = JSON.parse(healed);
      expect(parsed).toEqual({ name: "Alice", age: 3 });
    });

    it("nested incomplete heals to parseable JSON", () => {
      parser.write('{"items": [1, 2, {"sub": "val');
      const healed = parser.getHealed();
      const parsed = JSON.parse(healed);
      expect(parsed).toEqual({ items: [1, 2, { sub: "val" }] });
    });

    it("incomplete literal heals to correct value", () => {
      parser.write('{"done": fal');
      const parsed = JSON.parse(parser.getHealed());
      expect(parsed).toEqual({ done: false });
    });
  });

  // -----------------------------------------------------------------------
  // Whitespace handling
  // -----------------------------------------------------------------------

  describe("whitespace", () => {
    it("handles leading whitespace", () => {
      parser.write("  {");
      expect(parser.getHealed()).toBe("  {}");
    });

    it("handles whitespace between tokens", () => {
      parser.write('{ "a" : 1 }');
      expect(parser.getHealed()).toBe('{ "a" : 1 }');
      expect(parser.isComplete).toBe(true);
    });

    it("handles newlines and tabs", () => {
      parser.write('{\n\t"a":\n\t1');
      expect(parser.getHealed()).toBe('{\n\t"a":\n\t1}');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases — empty values and containers
  // -----------------------------------------------------------------------

  describe("edge cases — empty values and containers", () => {
    it("handles empty string value", () => {
      parser.write('{"a": ""}');
      expect(parser.getHealed()).toBe('{"a": ""}');
      expect(parser.isComplete).toBe(true);
    });

    it("handles empty string key", () => {
      parser.write('{"": 1}');
      expect(parser.getHealed()).toBe('{"": 1}');
      expect(parser.isComplete).toBe(true);
    });

    it("heals mid-empty-string value", () => {
      parser.write('{"a": "');
      expect(parser.getHealed()).toBe('{"a": ""}');
    });

    it("heals nested empty containers", () => {
      parser.write("[{}, [], [");
      expect(parser.getHealed()).toBe("[{}, [], []]");
      expect(() => JSON.parse(parser.getHealed())).not.toThrow();
    });

    it("handles object with only empty containers", () => {
      parser.write('{"a": {}, "b": []}');
      expect(parser.getHealed()).toBe('{"a": {}, "b": []}');
      expect(parser.isComplete).toBe(true);
    });

    it("handles empty array as top-level value", () => {
      parser.write("[]");
      expect(parser.isComplete).toBe(true);
    });

    it("handles empty object as top-level value", () => {
      parser.write("{}");
      expect(parser.isComplete).toBe(true);
    });

    it("handles array of empty arrays", () => {
      parser.write("[[], [], ");
      expect(parser.getHealed()).toBe("[[], []]");
    });

    it("handles key with escaped quote", () => {
      parser.write('{"say \\"hi');
      const healed = parser.getHealed();
      expect(healed).toBe('{"say \\"hi": null}');
      expect(() => JSON.parse(healed)).not.toThrow();
    });

    it("handles value string with multiple escapes", () => {
      parser.write('{"a": "\\t\\n\\\\\\"');
      const healed = parser.getHealed();
      expect(healed).toBe('{"a": "\\t\\n\\\\\\""}');
      expect(() => JSON.parse(healed)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // end() method
  // -----------------------------------------------------------------------

  describe("end()", () => {
    it("completes a top-level number", () => {
      parser.write("42");
      expect(parser.isComplete).toBe(false);
      parser.end();
      expect(parser.isComplete).toBe(true);
      expect(parser.getHealed()).toBe("42");
    });

    it("completes a top-level negative number", () => {
      parser.write("-7");
      parser.end();
      expect(parser.isComplete).toBe(true);
    });

    it("completes a top-level float", () => {
      parser.write("3.14");
      parser.end();
      expect(parser.isComplete).toBe(true);
    });

    it("is a no-op when already complete", () => {
      parser.write("{}");
      expect(parser.isComplete).toBe(true);
      parser.end();
      expect(parser.isComplete).toBe(true);
      expect(parser.getHealed()).toBe("{}");
    });

    it("is idempotent (double call)", () => {
      parser.write("42");
      parser.end();
      parser.end();
      expect(parser.isComplete).toBe(true);
      expect(parser.getHealed()).toBe("42");
    });

    it("does not complete when containers are still open", () => {
      parser.write('{"a": 1');
      parser.end();
      expect(parser.isComplete).toBe(false);
      // Healing still works
      expect(parser.getHealed()).toBe('{"a": 1}');
    });

    it("does not complete a partial literal", () => {
      parser.write("tru");
      parser.end();
      // literalIndex (3) !== literalTarget.length (4), so end() is a no-op
      expect(parser.isComplete).toBe(false);
      expect(parser.getHealed()).toBe("true");
    });

    it("does not complete an in-progress string", () => {
      parser.write('"hello');
      parser.end();
      expect(parser.isComplete).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Trailing content after completion (regression)
  // -----------------------------------------------------------------------

  describe("trailing content after completion", () => {
    it("excludes trailing content from raw when completing mid-chunk", () => {
      parser.write("{}extra");
      expect(parser.isComplete).toBe(true);
      expect(parser.getRaw()).toBe("{}");
      expect(parser.getHealed()).toBe("{}");
    });

    it("excludes trailing content for arrays", () => {
      parser.write("[1]trailing");
      expect(parser.isComplete).toBe(true);
      expect(parser.getRaw()).toBe("[1]");
    });

    it("excludes trailing content for strings", () => {
      parser.write('"hello"world');
      expect(parser.isComplete).toBe(true);
      expect(parser.getRaw()).toBe('"hello"');
    });

    it("excludes trailing content for top-level literal", () => {
      parser.write("nullextra");
      expect(parser.isComplete).toBe(true);
      expect(parser.getRaw()).toBe("null");
    });

    it("healed output is valid JSON when trailing content would break it", () => {
      parser.write('{"a": 1}{"b": 2}');
      expect(parser.isComplete).toBe(true);
      const healed = parser.getHealed();
      expect(healed).toBe('{"a": 1}');
      expect(JSON.parse(healed)).toEqual({ a: 1 });
    });

    it("handles top-level number completed by whitespace in same chunk", () => {
      parser.write("42 ");
      // The space terminates the number; only "42" should be in raw.
      expect(parser.isComplete).toBe(true);
      expect(parser.getRaw()).toBe("42");
      expect(parser.getHealed()).toBe("42");
    });

    it("onComplete receives clean raw without trailing content", () => {
      const completions: string[] = [];
      parser.onComplete = (j) => completions.push(j);
      parser.write("{}garbage");
      expect(completions).toEqual(["{}",]);
    });
  });

  // -----------------------------------------------------------------------
  // Malformed / adversarial input
  // -----------------------------------------------------------------------

  describe("malformed input", () => {
    it("silently skips unrecognised characters in value position", () => {
      // Garbage chars in value position are skipped; the healing still adds
      // a placeholder.  Note: the raw buffer retains them, so the healed
      // output will NOT parse — this is expected for invalid input.
      parser.write('{"a": !}');
      const healed = parser.getHealed();
      // The `!` is skipped, `}` doesn't close because phase is OBJ_VALUE,
      // so the object never closes in the FSA.
      expect(parser.isComplete).toBe(false);
    });

    it("handles lone closing brace", () => {
      parser.write("}");
      // `}` with no open object — silently skipped
      expect(parser.isComplete).toBe(false);
      expect(parser.getHealed()).toBe("}");
    });

    it("handles lone closing bracket", () => {
      parser.write("]");
      expect(parser.isComplete).toBe(false);
    });

    it("handles double comma in array (invalid JSON)", () => {
      // Double comma: first `,` sets ARR_AFTER_COMMA, second `,` doesn't
      // match any transition and is silently absorbed into raw.
      parser.write("[1,,2]");
      // The parser does complete (it sees valid structural flow around the
      // extra comma since `2` starts a new value).
      expect(parser.isComplete).toBe(true);
      // But the raw contains `,,` which is invalid JSON.
      expect(() => JSON.parse(parser.getHealed())).toThrow();
    });

    it("handles unescaped newline inside string", () => {
      // JSON spec forbids literal control characters in strings, but the
      // parser's FSA does not reject them.  The healed output will contain
      // the raw newline and JSON.parse will reject it.
      parser.write('{"a": "line1\nline2"}');
      expect(parser.isComplete).toBe(true);
      expect(() => JSON.parse(parser.getHealed())).toThrow();
    });

    it("BOM prefix is absorbed into raw", () => {
      parser.write('\uFEFF{"a": 1}');
      expect(parser.isComplete).toBe(true);
      // The BOM is an unrecognised char — silently skipped by the FSA but
      // retained in raw.  Whether JSON.parse accepts it is engine-dependent
      // (V8 does, JavaScriptCore does not), so we just verify completion.
      expect(parser.getRaw()).toBe('\uFEFF{"a": 1}');
    });

    it("handles numeric key attempt (invalid JSON)", () => {
      // `{123` — `1` starts a number in OBJ_EMPTY context. The FSA doesn't
      // enforce that keys must be strings, so it proceeds incorrectly.
      parser.write("{123");
      expect(parser.isComplete).toBe(false);
      // Output will not be valid JSON
      expect(() => JSON.parse(parser.getHealed())).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Key-vs-value string context
  // -----------------------------------------------------------------------

  describe("key vs value string context", () => {
    it("heals partial key in empty object as key", () => {
      parser.write('{"ke');
      expect(parser.getHealed()).toBe('{"ke": null}');
      expect(JSON.parse(parser.getHealed())).toEqual({ ke: null });
    });

    it("heals partial key after comma as key", () => {
      parser.write('{"a": 1, "ke');
      expect(parser.getHealed()).toBe('{"a": 1, "ke": null}');
      expect(JSON.parse(parser.getHealed())).toEqual({ a: 1, ke: null });
    });

    it("heals partial value string (not mistaken for key)", () => {
      parser.write('{"a": "va');
      expect(parser.getHealed()).toBe('{"a": "va"}');
      expect(JSON.parse(parser.getHealed())).toEqual({ a: "va" });
    });

    it("heals key immediately after colon with no space", () => {
      parser.write('{"a":"va');
      expect(parser.getHealed()).toBe('{"a":"va"}');
      expect(JSON.parse(parser.getHealed())).toEqual({ a: "va" });
    });

    it("heals string in array (always value context)", () => {
      parser.write('["ke');
      expect(parser.getHealed()).toBe('["ke"]');
      expect(JSON.parse(parser.getHealed())).toEqual(["ke"]);
    });

    it("unicode escape in key heals with key suffix", () => {
      parser.write('{"\\u00');
      const healed = parser.getHealed();
      expect(healed).toBe('{"\\u0000": null}');
      expect(JSON.parse(healed)).toEqual({ "\u0000": null });
    });
  });

  // -----------------------------------------------------------------------
  // Large input / deep nesting / performance
  // -----------------------------------------------------------------------

  describe("large input and deep nesting", () => {
    it("handles deeply nested arrays (depth 100)", () => {
      const opens = "[".repeat(100);
      parser.write(opens);
      expect(parser.depth).toBe(100);
      const healed = parser.getHealed();
      expect(healed).toBe(opens + "]".repeat(100));
      expect(() => JSON.parse(healed)).not.toThrow();
    });

    it("handles deeply nested objects (depth 50)", () => {
      // {"a":{"a":{"a":...
      let input = "";
      for (let i = 0; i < 50; i++) {
        input += '{"a":';
      }
      input += "1";
      parser.write(input);
      expect(parser.depth).toBe(50);
      const healed = parser.getHealed();
      expect(() => JSON.parse(healed)).not.toThrow();
      // Innermost value should be 1
      let parsed = JSON.parse(healed);
      for (let i = 0; i < 50; i++) {
        parsed = parsed.a;
      }
      expect(parsed).toBe(1);
    });

    it("processes 10KB of streaming JSON correctly", () => {
      // Build a large JSON object streamed in small chunks
      const keys: string[] = [];
      parser.write("{");
      for (let i = 0; i < 500; i++) {
        if (i > 0) parser.write(", ");
        const key = `key_${i.toString().padStart(4, "0")}`;
        keys.push(key);
        parser.write(`"${key}": ${i}`);
      }
      parser.write("}");

      expect(parser.isComplete).toBe(true);
      const parsed = JSON.parse(parser.getHealed());
      expect(Object.keys(parsed).length).toBe(500);
      expect(parsed[keys[0]!]).toBe(0);
      expect(parsed[keys[499]!]).toBe(499);
    });

    it("heals correctly at every step of large streaming input", () => {
      // Stream a 200-element array character by character and verify every
      // intermediate state is valid JSON.
      const elements = Array.from({ length: 200 }, (_, i) => i);
      const input = JSON.stringify(elements);
      let invalidCount = 0;

      for (let i = 0; i < input.length; i++) {
        parser.write(input[i]!);
        try {
          JSON.parse(parser.getHealed());
        } catch {
          invalidCount++;
        }
      }
      expect(invalidCount).toBe(0);
      parser.end();
      expect(parser.isComplete).toBe(true);
    });

    it("healing suffix is constant-time regardless of input size", () => {
      // Feed a large chunk, then verify the healing suffix is short
      // (O(depth), not O(input_length)).  Trailing comma is trimmed, then
      // a single `]` is appended — net change is small.
      const bigArray =
        "[" + Array.from({ length: 1000 }, (_, i) => i).join(",") + ",";
      parser.write(bigArray);

      const healed = parser.getHealed();
      const raw = parser.getRaw();
      // Raw ends with `,`; healed trims it and appends `]`.
      // So healed = raw[0..-2] + "]", same total length.
      expect(healed.endsWith("]")).toBe(true);
      expect(healed).not.toContain("null"); // no dummy padding values
      expect(() => JSON.parse(healed)).not.toThrow();
      // Verify the array is intact (999 is the last real element)
      const parsed = JSON.parse(healed) as number[];
      expect(parsed[parsed.length - 1]).toBe(999);
    });
  });

  // -----------------------------------------------------------------------
  // Sandbox integration simulation
  // -----------------------------------------------------------------------

  describe("sandbox integration simulation", () => {
    /**
     * Simulates the sandbox's tool-input-delta flow:
     *  1. Host sends raw JSON deltas (chunks of tool arguments)
     *  2. Sandbox feeds each delta into the parser
     *  3. Sandbox parses the healed output and forwards as tool-input-partial
     */
    function simulateSandbox(deltas: string[]): Array<Record<string, unknown>> {
      const parser = new IncrementalJsonParser();
      const partials: Array<Record<string, unknown>> = [];

      for (const delta of deltas) {
        parser.write(delta);
        const healed = parser.getHealed();
        try {
          const args = JSON.parse(healed);
          if (typeof args === "object" && args !== null) {
            partials.push(args as Record<string, unknown>);
          }
        } catch {
          // Skip deltas that don't produce parseable JSON
        }
      }

      return partials;
    }

    it("produces progressively richer partial arguments", () => {
      const deltas = [
        '{"loc',
        'ation": "N',
        "ew York",
        '", "units": "met',
        'ric"}',
      ];

      const partials = simulateSandbox(deltas);

      expect(partials.length).toBe(5);
      // First delta: partial key
      expect(partials[0]).toEqual({ loc: null });
      // Second: key complete with partial value
      expect(partials[1]).toEqual({ location: "N" });
      // Third: value growing
      expect(partials[2]).toEqual({ location: "New York" });
      // Fourth: second key partial
      expect(partials[3]).toEqual({ location: "New York", units: "met" });
      // Fifth: complete
      expect(partials[4]).toEqual({ location: "New York", units: "metric" });
    });

    it("handles chart data streaming", () => {
      const deltas = [
        '{"data": [',
        '{"x": 1, "y": ',
        "10}",
        ', {"x": 2, "y": 20',
        "}",
        "]}",
      ];

      const partials = simulateSandbox(deltas);

      // After first delta: empty data array
      expect(partials[0]).toEqual({ data: [] });
      // After second: first point with partial y
      expect(partials[1]).toEqual({ data: [{ x: 1, y: null }] });
      // After third: first point complete
      expect(partials[2]).toEqual({ data: [{ x: 1, y: 10 }] });
      // After fourth: second point partial
      expect(partials[3]).toEqual({ data: [{ x: 1, y: 10 }, { x: 2, y: 20 }] });
      // After fifth: second point complete
      expect(partials[4]).toEqual({
        data: [
          { x: 1, y: 10 },
          { x: 2, y: 20 },
        ],
      });
      // Final: complete
      expect(partials[5]).toEqual({
        data: [
          { x: 1, y: 10 },
          { x: 2, y: 20 },
        ],
      });
    });

    it("reset between tool calls works correctly", () => {
      const parser = new IncrementalJsonParser();
      const results: Array<Record<string, unknown>> = [];

      // First tool call
      for (const delta of ['{"a": ', "1}"]) {
        parser.write(delta);
      }
      results.push(JSON.parse(parser.getHealed()));

      // Reset (like sandbox does on tool-input)
      parser.reset();

      // Second tool call
      for (const delta of ['{"b": ', "2}"]) {
        parser.write(delta);
      }
      results.push(JSON.parse(parser.getHealed()));

      expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it("every partial is valid JSON", () => {
      // Simulate realistic LLM streaming: character-by-character tool args
      const fullArgs = '{"query": "climate change", "maxResults": 10, "filters": {"year": 2024, "language": "en"}}';
      const parser = new IncrementalJsonParser();
      let invalidCount = 0;

      for (let i = 0; i < fullArgs.length; i++) {
        parser.write(fullArgs[i]!);
        try {
          JSON.parse(parser.getHealed());
        } catch {
          invalidCount++;
        }
      }

      expect(invalidCount).toBe(0);
      expect(parser.isComplete).toBe(true);
      expect(JSON.parse(parser.getHealed())).toEqual({
        query: "climate change",
        maxResults: 10,
        filters: { year: 2024, language: "en" },
      });
    });
  });
});
