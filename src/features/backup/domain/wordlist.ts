/**
 * The passphrase wordlist: 512 words, so each word carries exactly 9 bits.
 *
 * 512 rather than BIP-39's 2048 because no bip39 package is a dependency here and
 * vendoring 2048 words to gain 2 bits per word is a poor trade — nine words from
 * this list is **81 bits**, which at Argon2id's ~1 s per guess is not a search
 * that finishes. Entropy comes from the word count, and the word count is cheap.
 *
 * The list is deliberately boring: 4–8 letters, ASCII lowercase, no plurals of
 * other entries, and every word has a **unique four-letter prefix**, so a
 * transcription that loses the tail is still unambiguous to a human comparing it
 * against this file. `tests/backup-wordlist.test.ts` asserts all of that plus the
 * count, because a duplicate would silently cost entropy and nothing would fail.
 *
 * Nothing decodes a passphrase back into indices — the words are joined with
 * single spaces and handed to Argon2id as UTF-8 — so this list can grow in a later
 * format version without breaking a single existing artifact.
 */
export const PASSPHRASE_WORDLIST: readonly string[] = [
  "able", "about", "above", "acid", "acorn", "acre", "actor", "adapt",
  "adopt", "adult", "after", "again", "agent", "agree", "ahead", "alarm",
  "album", "alert", "alien", "alike", "alive", "allow", "almond", "alone",
  "alpha", "amber", "among", "anchor", "angel", "angle", "badge", "bagel",
  "baker", "balance", "balcony", "bamboo", "banana", "banjo", "banner", "barley",
  "basil", "basket", "batch", "beacon", "beam", "bean", "beaver", "bell",
  "belt", "bench", "berry", "better", "beyond", "bicycle", "binary", "birch",
  "bishop", "bison", "bitter", "black", "blade", "blanket", "cabin", "cable",
  "cactus", "cadet", "camel", "campus", "candle", "canoe", "canvas", "canyon",
  "capital", "caramel", "carbon", "cargo", "carpet", "carrot", "castle", "catalog",
  "cattle", "cause", "cavern", "cedar", "celery", "cellar", "cement", "census",
  "cereal", "chain", "chalk", "chapel", "charm", "cheese", "cherry", "chess",
  "chief", "chili", "chimney", "chorus", "cider", "cinema", "daily", "dairy",
  "daisy", "dance", "dawn", "decade", "decide", "deck", "decor", "deep",
  "deer", "delta", "denim", "dense", "depart", "depth", "desert", "design",
  "desk", "detail", "device", "diary", "diesel", "digital", "dinner", "direct",
  "dish", "distant", "eagle", "early", "earth", "easel", "east", "echo",
  "eclipse", "edge", "effort", "eight", "elbow", "elder", "elegant", "element",
  "elite", "ember", "empire", "energy", "eternal", "evening", "exact", "expert",
  "extra", "fabric", "factory", "falcon", "family", "famous", "fancy", "farm",
  "fashion", "fault", "feast", "feather", "fence", "ferry", "festival", "fiber",
  "fiction", "field", "figure", "filter", "final", "finger", "fire", "first",
  "fiscal", "fitness", "flame", "gadget", "galaxy", "gallery", "garden", "garlic",
  "gather", "gauge", "gazelle", "gentle", "genuine", "giant", "ginger", "giraffe",
  "glacier", "glass", "globe", "glory", "golden", "granite", "grape", "habit",
  "hammer", "handle", "harbor", "harmony", "harvest", "hazel", "healthy", "hearth",
  "heavy", "hedge", "helmet", "herbal", "hero", "hidden", "highway", "hollow",
  "honey", "horizon", "hunter", "iceberg", "icon", "ideal", "igloo", "image",
  "impact", "import", "inch", "index", "indigo", "insect", "invest", "invite",
  "iris", "island", "ivory", "jacket", "jaguar", "jasmine", "jelly", "jewel",
  "jigsaw", "journal", "jungle", "kayak", "kernel", "kettle", "keyboard", "kindly",
  "kingdom", "kitchen", "kitten", "label", "ladder", "lagoon", "lantern", "laptop",
  "laser", "lattice", "laundry", "lavender", "layer", "leader", "leather", "legacy",
  "lemon", "lentil", "lesson", "letter", "level", "liberty", "library", "machine",
  "magnet", "maple", "marble", "margin", "marine", "market", "marvel", "mason",
  "master", "matrix", "meadow", "medal", "melody", "member", "memory", "mentor",
  "mercury", "merit", "method", "midnight", "mighty", "mineral", "minute", "mirror",
  "mobile", "modern", "monarch", "napkin", "narrow", "nation", "nature", "navy",
  "nectar", "needle", "neighbor", "nephew", "nickel", "nimble", "noble", "notebook",
  "oasis", "oatmeal", "object", "ocean", "october", "office", "olive", "onion",
  "opal", "opera", "orange", "orbit", "orchid", "otter", "outdoor", "oxygen",
  "oyster", "pacific", "package", "paddle", "palace", "palm", "pancake", "panda",
  "panel", "pantry", "paper", "parade", "parcel", "parent", "parsley", "pasta",
  "patch", "patio", "pattern", "peach", "peanut", "pearl", "pebble", "pelican",
  "pencil", "pepper", "perfume", "petal", "phantom", "phoenix", "phrase", "piano",
  "picnic", "pigeon", "pillow", "quartz", "question", "quiet", "quilt", "rabbit",
  "radar", "radio", "rainbow", "raisin", "rally", "ranch", "random", "ranger",
  "rapid", "ratio", "reason", "record", "recycle", "reform", "region", "remedy",
  "rescue", "resort", "ribbon", "ridge", "river", "robin", "rocket", "saddle",
  "safari", "saffron", "sailor", "salad", "salmon", "sample", "sandal", "sapphire",
  "satin", "sauce", "scarf", "scenic", "school", "science", "scooter", "sculpt",
  "season", "second", "sector", "sedan", "senate", "sentry", "sequoia", "serene",
  "sesame", "settle", "shadow", "shampoo", "sharp", "shelter", "sheriff", "shield",
  "shrimp", "shuttle", "sierra", "signal", "silver", "simple", "singer", "siren",
  "sketch", "skyline", "sleeve", "slogan", "spiral", "tablet", "tactic", "talent",
  "tandem", "tango", "tapestry", "target", "tavern", "teapot", "temple", "tender",
  "tennis", "terrace", "textile", "theater", "thermal", "thistle", "thunder", "ticket",
  "tiger", "timber", "tissue", "toast", "tomato", "topaz", "tornado", "tourist",
  "tulip", "ultra", "umbrella", "uncle", "unicorn", "uniform", "unique", "update",
  "upward", "urban", "vacuum", "valley", "vanilla", "vapor", "velvet", "venue",
  "vessel", "victory", "village", "violet", "waffle", "wagon", "walnut", "walrus",
  "wander", "warden", "warmth", "washer", "water", "wealth", "weather", "wedge",
  "weekly", "welcome", "wheat", "whisper", "willow", "window", "winter", "wisdom",
  "yacht", "yellow", "yogurt", "youth", "zebra", "zenith", "zigzag", "zipper",
];

/** 512 = 2^9, so the rejection-free index draw below is exactly 9 bits per word. */
export const WORDLIST_SIZE = 512;

/** log2(512) — the entropy each word contributes. */
export const BITS_PER_WORD = 9;
