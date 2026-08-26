/**
 * Syntax highlighting for the text/code previewer.
 *
 * What comes out of `highlightLine` is written straight into the DOM with
 * `dangerouslySetInnerHTML`, and what goes in is file content — uploaded by
 * another member of a shared folder, or by whoever created the public share link
 * being viewed. So escaping it is a security boundary, not a formatting detail.
 *
 * It used to be neither. The JSON highlighter ran its regexes over the raw line
 * and the Markdown one did too on any line containing a link, `**bold**`, or a
 * backtick, so `<img src=x onerror=...>` in a previewed `.json`/`.md` file
 * executed on our origin in the session of whoever opened the preview.
 *
 * Escaping first would fix that but not the reason it was easy to get wrong: the
 * highlighters are chained `String.replace` calls, so each pass also sees the
 * markup the previous ones inserted. (`class="text-amber-400"` contains a number
 * and the word `class`, both of which the later passes happily wrapped in another
 * span — most code lines came out as malformed tags.) So the passes now emit inert
 * control-character tokens instead of markup: the text stays plain while they run,
 * gets escaped once at the end, and only then are the tokens swapped for the real
 * tags. Nothing a pass inserts can be seen by the next one, and nothing the file
 * contains can look like a token.
 */

/** Token delimiters. Control characters: inert for every pattern below, and
 *  untouched by escaping, so a token survives `escapeHtml` intact. */
const TOKEN_START = "\u0000";
const TOKEN_END = "\u0001";
/** Slot index, written in unary — digits would be matched by the number pass. */
const TOKEN_UNIT = "\u0002";

/** Stripped from the input, so file content can never forge a token. */
const TOKEN_CHARS = /[\u0000-\u0002]/g;
const TOKEN_PATTERN = /\u0000(\u0002+)\u0001/g;

/**
 * Markup held out of the string while the passes run, keyed by an inert token.
 */
class MarkupSlots {
  private readonly slots: string[] = [];

  /** A token standing in for `html`, reusing the slot if it is already held. */
  token(html: string): string {
    let index = this.slots.indexOf(html);
    if (index < 0) index = this.slots.push(html) - 1;
    return TOKEN_START + TOKEN_UNIT.repeat(index + 1) + TOKEN_END;
  }

  /** Wrap `inner` — already-tokenized text — in an open/close pair. */
  wrap(open: string, inner: string, close = "</span>"): string {
    return this.token(open) + inner + this.token(close);
  }

  /** Put the real markup back, once the surrounding text has been escaped. */
  render(text: string): string {
    return text.replace(
      TOKEN_PATTERN,
      (_match, units: string) => this.slots[units.length - 1] ?? ""
    );
  }
}

const LANG_MAP: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", php: "php",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less", sass: "sass",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", svg: "svg",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", bat: "batch",
  md: "markdown", mdx: "markdown",
  vue: "vue", svelte: "svelte", astro: "astro",
  txt: "text", log: "text", env: "text", ini: "text", cfg: "text", conf: "text",
  gitignore: "text", dockerignore: "text", makefile: "text", dockerfile: "text",
};

export function getLanguage(ext: string): string {
  return LANG_MAP[ext] || "text";
}

/**
 * Neutralize the three characters that can start markup in element content.
 *
 * Quotes are deliberately left alone: the output is only ever inserted as the
 * content of a `<span>`, never into an attribute, and escaping them would stop the
 * string-literal patterns from matching.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlighters for languages with their own line grammar.
 *
 * Each receives the plain line and returns it with markup replaced by tokens from
 * `slots` — never with markup, which is what let the later passes chew on the
 * earlier ones' output.
 */
const HIGHLIGHTERS: Record<string, (line: string, slots: MarkupSlots) => string> = {
  json(line: string, slots: MarkupSlots): string {
    const key = slots.token('<span class="text-violet-400">');
    const string = slots.token('<span class="text-emerald-400">');
    const number = slots.token('<span class="text-amber-400">');
    const literal = slots.token('<span class="text-cyan-400">');
    const end = slots.token("</span>");
    return line
      .replace(/"([^"\\]|\\.)*"\s*:/g, (m) => `${key}${m.slice(0, -1)}${end}:`)
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, `: ${string}$1${end}`)
      .replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g, `: ${number}$1${end}`)
      .replace(/:\s*(true|false|null)/g, `: ${literal}$1${end}`);
  },
  markdown(line: string, slots: MarkupSlots): string {
    const header = line.match(/^(#{1,6})\s+(.+)$/);
    if (header) {
      return `${slots.wrap('<span class="text-violet-400 font-bold">', header[1])} ${slots.wrap('<span class="font-semibold">', header[2])}`;
    }
    const list = line.match(/^(\s*[-*+]\s)(.+)$/);
    if (list) return `${slots.wrap('<span class="text-accent">', list[1])}${list[2]}`;
    if (/^`{3,}/.test(line)) return slots.wrap('<span class="text-emerald-400">', line);
    if (/\[[^\]]+\]\([^)]+\)/.test(line)) {
      return line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string) =>
        slots.wrap('<span class="text-blue-400 underline">', text)
      );
    }
    if (/\*\*.+?\*\*/.test(line)) {
      return line.replace(/\*\*(.+?)\*\*/g, (_m, text: string) =>
        slots.wrap("<strong>", text, "</strong>")
      );
    }
    if (/`.+?`/.test(line)) {
      return line.replace(/`(.+?)`/g, (_m, text: string) =>
        slots.wrap('<code class="bg-accent/10 px-1 rounded text-emerald-400">', text, "</code>")
      );
    }
    return line;
  },
};

const KEYWORD_SETS: Record<string, { keywords: string; types: string; decorators?: string; builtins?: string }> = {
  javascript: {
    keywords: "\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|this|typeof|instanceof|void|delete|in|of|class|extends|super|import|export|default|from|as|async|await|yield|static|get|set|true|false|null|undefined|NaN|Infinity)\\b",
    types: "\\b(string|number|boolean|any|void|never|null|undefined|object|symbol|bigint|Array|Promise|Map|Set|WeakMap|WeakSet|Error|Date|RegExp|Function|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|InstanceType)\\b",
  },
  typescript: {
    keywords: "\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|this|typeof|instanceof|void|delete|in|of|class|extends|super|import|export|default|from|as|async|await|yield|static|get|set|true|false|null|undefined|NaN|Infinity|interface|type|enum|namespace|module|declare|abstract|readonly|private|protected|public|implements|satisfies)\\b",
    types: "\\b(string|number|boolean|any|void|never|null|undefined|object|symbol|bigint|Array|Promise|Map|Set|WeakMap|WeakSet|Error|Date|RegExp|Function|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|InstanceType|Parameters|ConstructorParameters|Awaited)\\b",
    decorators: "@\\w+",
  },
  python: {
    keywords: "\\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|pass|break|continue|yield|lambda|async|await|True|False|None|and|or|not|is|in|del|global|nonlocal|assert|self|cls|print|len|range|map|filter|zip|enumerate|sorted|reversed|super|property|staticmethod|classmethod)\\b",
    types: "\\b(int|float|str|bool|list|dict|tuple|set|frozenset|bytes|bytearray|NoneType|Any|Optional|Union|List|Dict|Tuple|Set|Callable|Iterable|Iterator|Generator|TypeVar)\\b",
    decorators: "@\\w+(?:\\.\\w+)?",
    builtins: "\\b(__init__|__str__|__repr__|__len__|__getitem__|__setitem__|__call__|__enter__|__exit__|__aenter__|__aexit__|__aiter__|__anext__|__await__)\\b",
  },
  go: {
    keywords: "\\b(func|return|if|else|for|range|switch|case|default|break|continue|go|defer|select|chan|struct|interface|map|type|package|import|var|const|true|false|nil|fallthrough|goto|iota|append|len|cap|make|new|close|delete|panic|recover|error|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|byte|rune|bool)\\b",
    types: "\\b(error|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|byte|rune|bool|any|comparable)\\b",
  },
  rust: {
    keywords: "\\b(fn|let|mut|const|static|return|if|else|for|while|loop|match|break|continue|struct|enum|impl|trait|pub|use|mod|crate|self|super|where|as|in|ref|move|async|await|unsafe|true|false|Some|None|Ok|Err|macro_rules|type|dyn|impl|union|extern|abstract|become|box|do|final|macro|override|priv|typeof|unsized|virtual|yield)\\b",
    types: "\\b(i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|HashMap|HashSet|Box|Option|Result|Arc|Rc|Mutex|RwLock|Cell|RefCell|Cow|Deref)\\b",
  },
  java: {
    keywords: "\\b(class|interface|enum|extends|implements|public|private|protected|static|final|abstract|synchronized|volatile|transient|native|strictfp|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|new|this|super|import|package|true|false|null|void|var|record|sealed|permits|non-sealed|yield|assert|default|instanceof)\\b",
    types: "\\b(String|Integer|Long|Double|Float|Boolean|Byte|Short|Character|Object|Class|List|ArrayList|Map|HashMap|Set|HashSet|Collection|Iterator|Optional|Stream|Runnable|Callable|Thread|Exception|RuntimeException|Error|Throwable)\\b",
    decorators: "@\\w+",
  },
  html: {
    keywords: "",
    types: "",
  },
  css: {
    keywords: "",
    types: "",
  },
};

/** Keyword/string/number colouring for everything else. Emits tokens, not markup. */
function genericHighlight(line: string, lang: string, slots: MarkupSlots): string {
  let result = line;
  const end = slots.token("</span>");
  const open = (html: string) => slots.token(html);

  const langConfig = KEYWORD_SETS[lang];

  if (langConfig && lang !== "text") {
    // Decorators (@ annotations)
    if (langConfig.decorators) {
      const decoratorRe = new RegExp(langConfig.decorators, "g");
      result = result.replace(decoratorRe, `${open('<span class="text-amber-400">')}$&${end}`);
    }

    // Builtins (__dunder__ methods in Python, etc.)
    if (langConfig.builtins) {
      const builtinRe = new RegExp(langConfig.builtins, "g");
      result = result.replace(builtinRe, `${open('<span class="text-cyan-400">')}$&${end}`);
    }
  }

  if (lang !== "text") {
    // Comments (line comments: // and #)
    const lineCommentRe = /(\/\/.*$|#.*$)/gm;
    result = result.replace(
      lineCommentRe,
      `${open('<span class="text-muted-foreground/50 italic">')}$1${end}`
    );

    // Strings (single, double, backtick)
    const stringRe = /(["'`])(?:(?!\1|\\).|\\.)*\1/g;
    result = result.replace(stringRe, `${open('<span class="text-emerald-400">')}$&${end}`);

    // Numbers
    const numberRe = /\b(\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g;
    result = result.replace(numberRe, `${open('<span class="text-amber-400">')}$1${end}`);
  }

  if (langConfig) {
    // Keywords
    if (langConfig.keywords) {
      const kwRe = new RegExp(langConfig.keywords, "g");
      result = result.replace(
        kwRe,
        `${open('<span class="text-violet-400 font-medium">')}$1${end}`
      );
    }
    // Types
    if (langConfig.types) {
      const typeRe = new RegExp(langConfig.types, "g");
      result = result.replace(typeRe, `${open('<span class="text-cyan-400">')}$1${end}`);
    }
  }

  return result;
}

/**
 * Turn one line of a previewed file into markup.
 *
 * Order matters and is the whole point: the passes see plain text and leave
 * tokens, then everything the file contributed is escaped, and only then do the
 * tokens become tags. No highlighter can forget to escape, because none of them
 * escapes anything; and no pass can corrupt another's markup, because there is no
 * markup in the string while they run.
 */
export function highlightLine(line: string, language: string): string {
  const slots = new MarkupSlots();
  // A token is made of control characters, so drop those from the input first.
  const plain = line.replace(TOKEN_CHARS, "�");
  const highlighter = HIGHLIGHTERS[language];
  const tokenized = highlighter
    ? highlighter(plain, slots)
    : genericHighlight(plain, language, slots);
  return slots.render(escapeHtml(tokenized));
}
