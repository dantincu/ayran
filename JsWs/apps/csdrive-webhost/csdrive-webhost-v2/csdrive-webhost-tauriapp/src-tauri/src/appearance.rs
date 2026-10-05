//! The app's appearance: which **theme** (the colours of the admin-app and of the system apps, see `src/lib/themes.ts`) and
//! whether it is **light, dark or the device's own** (`mode`), and whether the theme **rotates** through all the themes (`rotation`).
//! One choice for the whole app, kept in `data.db`'s `global_settings` (so it follows the data folder).
//!
//! **Any window may choose the theme and the mode** (`set_appearance`) — the person decided that web apps may — but **only the admin-app sets the
//! rotation** (`set_appearance_rotation`: a page that rotates the colours of the whole app every half minute isn't a page's business), and the
//! generic `set_global_setting` refuses these keys. Every window may *read* it (`get_appearance`) and is *told* when it changes: the event
//! [`EVENT`] goes to the admin-app and to every open window. A system app applies the theme itself (it is a page of the same frontend,
//! `lib/appearance.ts`); a web app's colours are its own, so for it the event is only an offer — it may listen (`TabLib.appearance`) and follow
//! the dark or light mode, or ignore it. Besides that, the mode also reaches the webviews themselves (desktop: the app's theme, which the
//! webview's `prefers-color-scheme` follows; every page: the css `color-scheme`, a snippet of `code_snippets.rs`), so the form controls,
//! scrollbars and `prefers-color-scheme` rules of a web app follow a *manual* light or dark mode too. (Android's WebView takes its
//! `prefers-color-scheme` from the system, so a web app there learns of a manual mode through the snippet and the event.)
//!
//! **Rotation** is done here, not in a page, so it goes on whatever is on screen: a task looks every second whether the interval has passed and,
//! when it has, moves to the next theme — the next in the catalog, the previous, or a random one other than the current — and tells every window.
//! Choosing a theme by hand doesn't stop it (it starts the interval again). **The interval is never shorter than [`MIN_INTERVAL_SECS`]** — one
//! second, so a person testing this can watch it happen quickly; there is no floor tied to "tiring to look at" any more, since that's a matter
//! of taste the person setting the interval already gets to decide for themself by choosing a longer one.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::app_state::AppDbState;

/// The event every window is sent when the appearance changes: `{ theme, mode, dark, rotation }`.
pub const EVENT: &str = "appearance-changed";

const THEME_KEY: &str = "appearance.theme";
const MODE_KEY: &str = "appearance.mode";
const ROTATION_KEY: &str = "appearance.rotation";
/// The last colour scheme a generated rotation drew — kept so it survives a restart and reaches a window that
/// opens between two rotation ticks, instead of a fresh draw whenever `read` happens to run.
const GENERATED_KEY: &str = "appearance.generated";
/// The colour scheme a generated rotation drew *before* the current one — kept so the person can still save it
/// (`save_custom_theme`) even after the rotation has already moved on to the next one, since by the time they
/// notice a nice draw and open the dialog, a short interval may well have ticked forward already. Only one step
/// of history is kept, not a running log: "the previously generated random theme" (asked for by name), not every
/// one there ever was. Updated only on a real rotation tick (`rotate_if_due`), never by merely re-saving the
/// rotation's other settings or toggling generated colours on/off.
const PREVIOUS_GENERATED_KEY: &str = "appearance.previousGenerated";
/// Every colour scheme the person has saved for picking again later — a generated one they liked (there's no
/// other way to keep one: the catalog is compiled in, so a "custom" theme is the only kind that can be added at
/// all) kept as its own list, never mixed into the compiled-in catalog it sits beside in the picker.
const CUSTOM_THEMES_KEY: &str = "appearance.customThemes";
/// The key colours a generated rotation is currently drawing near — absent (or empty) means the compiled-in
/// default, [`KEY_COLORS`]/[`KEY_COLOR_NAMES`]. See "Editable seed colours" below.
const KEY_COLORS_KEY: &str = "appearance.keyColors";
/// Every list of key colours the person has saved for picking again later — the key-colour counterpart of
/// [`CUSTOM_THEMES_KEY`], kept the same way and for the same reason (there's nowhere else a list that isn't the
/// one currently active could live).
const SAVED_KEY_COLOR_LISTS_KEY: &str = "appearance.savedKeyColorLists";
/// The keys of the global settings that only this module writes.
pub const RESERVED_PREFIX: &str = "appearance.";
/// A saved custom theme's name is at most this many characters — plenty for a short, readable label, the same
/// order of magnitude as a branch's own name limit (100, `docs/strategies/folder-pairs-strategy.md`'s neighbour).
pub const MAX_CUSTOM_THEME_NAME_LEN: usize = 80;
/// A key colour's own name is shorter — it's a one- or two-word label ("Red", "Sea foam"), not a theme's title.
pub const MAX_KEY_COLOR_NAME_LEN: usize = 40;
/// A saved key-colour list's name is the same order of magnitude as a saved theme's.
pub const MAX_SAVED_KEY_COLOR_LIST_NAME_LEN: usize = 80;
/// At least one colour to draw from (`generated_rgb`'s `% len()` would panic at zero), and a ceiling mostly to
/// keep the dialog's own list from growing unreasonably — a longer list just means a longer cycle before it
/// repeats, nothing breaks past this, but there's no real use for dozens of seed colours either.
pub const MAX_KEY_COLORS: usize = 24;

pub const DEFAULT_THEME: &str = "ayran-orange";
const MODES: [&str; 3] = ["system", "light", "dark"];

/// The shortest time between two rotations: one second, so it can be watched happening while testing.
pub const MIN_INTERVAL_SECS: u64 = 1;
/// The longest: a year.
const MAX_INTERVAL_SECS: u64 = 365 * 24 * 3600;

/// Every theme of the catalog (`src/lib/themes.ts`), in its order — what rotating goes through. A test keeps this list equal to the catalog's.
pub const THEME_IDS: &[&str] = &[
    "ayran-orange",
    "classic-blue",
    "dune-noon",
    "mirage",
    "sandstone-canyon",
    "cracked-clay",
    "ember-ash",
    "sun-baked-ochre",
    "lava-jungle",
    "basalt-turquoise",
    "orchid-caldera",
    "golden-maple",
    "harvest-gold",
    "orchard-crimson",
    "drizzle",
    "wet-leaves",
    "stormy-umber",
    "bog-mist",
    "cypress-fog",
    "murky-lagoon",
    "whiteout",
    "frost-mist",
    "blizzard-lavender",
    "red-clay",
    "rust",
    "copper",
    "arabica-coffee",
    "chocolate",
    "oak",
    "walnut",
    "birch",
    "gold",
    "silver",
    "platinum",
    "gun-metal",
    "ruby",
    "magenta",
    "violet",
    "velvet",
    "cherry",
    "pink",
    "teal",
    "dark-teal",
    "kelp",
    "nori",
    "sea-lettuce",
    "deep-woods",
    "pine-canopy",
    "mossy-glade",
    "cobalt",
    "sky",
    "midnight",
    "steel-blue",
    "cold-steel",
    "slate-harbour",
    "red-planet",
    "olympus-dust",
    "martian-dusk",
];

/// Whether the rotation makes up its own colours near six key hues instead of going through the catalog — see the
/// "Generated colours" section of the module doc.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedColors {
    pub enabled: bool,
    /// How far each RGB channel may drift from the key colour it is near, 0–255. Never validated against a
    /// range here (a `u8` already can't be more than 255): `0` always lands on the key colour exactly.
    pub spread: u8,
}

impl Default for GeneratedColors {
    fn default() -> Self {
        GeneratedColors { enabled: false, spread: DEFAULT_SPREAD }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rotation {
    pub enabled: bool,
    /// `ascending` (the next theme of the catalog), `descending` (the previous) or `random` (any other than the current one).
    /// Meaningless — and ignored — while `generated.enabled`: a generated rotation always goes forward through the six keys.
    pub mode: String,
    /// `seconds`, `minutes`, `hours` or `days`, and how many of them.
    pub unit: String,
    pub every: u32,
    /// `#[serde(default)]` so a `Rotation` saved before this field existed still deserializes (off, as it should).
    #[serde(default)]
    pub generated: GeneratedColors,
}

impl Default for Rotation {
    fn default() -> Self {
        Rotation { enabled: false, mode: "ascending".into(), unit: "minutes".into(), every: 5, generated: GeneratedColors::default() }
    }
}

impl Rotation {
    /// How long a theme stays, when the settings are valid.
    pub fn interval(&self) -> Result<Duration, String> {
        if !["ascending", "descending", "random"].contains(&self.mode.as_str()) {
            return Err("The rotation goes ascending, descending or random.".to_string());
        }
        let unit = match self.unit.as_str() {
            "seconds" => 1,
            "minutes" => 60,
            "hours" => 3600,
            "days" => 86_400,
            _ => return Err("The rotation's unit is seconds, minutes, hours or days.".to_string()),
        };
        let secs = (self.every as u64).saturating_mul(unit);
        if secs < MIN_INTERVAL_SECS {
            let plural = if MIN_INTERVAL_SECS == 1 { "" } else { "s" };
            return Err(format!("A theme stays at least {MIN_INTERVAL_SECS} second{plural}."));
        }
        if secs > MAX_INTERVAL_SECS {
            return Err("A theme stays at most a year.".to_string());
        }
        Ok(Duration::from_secs(secs))
    }
}

/// The colours a `Theme` of the catalog (`src/lib/themes.ts`'s `Palette`) has — spelled out here as its own
/// struct, rather than reusing anything theme-shaped, because a generated palette isn't one of the catalog's named
/// themes and has no `id`/`family`/`name` of its own. `accent_text` has no counterpart in `Palette`: a catalog
/// theme's own `accent` already doubles as its own text colour (a hand-picked value, not automatically checked
/// for it, but never a raw full-saturation primary either) — only a generated palette's `accent`, deliberately the
/// *raw* drawn key colour, needs a second, readable-as-text stand-in. See `readable_variant_of`'s own doc comment.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub accent_fg: String,
    /// A reduced-vividness stand-in for `accent`, guaranteed to clear the same 4.5:1 text-contrast bar `fg` does
    /// against `bg` — for the handful of places the app's own CSS uses the accent colour as literal text directly
    /// on the page's own background (a link, a badge, a tab's bullet: `color: var(--accent-text, var(--accent))`
    /// in `App.css`/`notes.css`), as opposed to `accent`'s primary role as a *background* an `accent_fg` text sits
    /// on top of. A catalog theme has none of its own — the CSS falls back to its plain `--accent` there, which
    /// already does double duty by the author's own choice.
    pub accent_text: String,
    pub panel: String,
    pub hover: String,
}

/// A colour scheme made up on the spot, near one of the six key hues — light and dark, like a catalog theme's.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPalette {
    /// Which of [`KEY_COLORS`] this was drawn near (also its name, [`KEY_COLOR_NAMES`]).
    pub key_index: u8,
    pub light: ThemeColors,
    pub dark: ThemeColors,
}

/// A colour scheme the person saved for picking again later — the one way a "generated" draw (otherwise gone the
/// moment the rotation moves on, or the app restarts) can be kept. Not one of the catalog's own [`THEME_IDS`]: its
/// `id` is made up on save (`custom-<uuid>`, never a catalog slug, so the two id spaces can never collide) and a
/// page resolves it with its *own* `light`/`dark` colours rather than a compiled-in `Palette`, since nothing about
/// a custom theme exists anywhere but this one saved record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub light: ThemeColors,
    pub dark: ThemeColors,
}

/// One colour a generated rotation can be drawn near — see "Editable seed colours" below. `color` is a plain
/// `#rrggbb` string, like every other colour this module stores (`ThemeColors`' own fields); never trusted into a
/// CSS variable or parsed until `validate_key_colors` has checked it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyColor {
    pub name: String,
    pub color: String,
}

/// A list of key colours the person saved for picking again later — the key-colour counterpart of
/// [`CustomTheme`], same reasoning: there's nowhere else a list that isn't the currently active one could live.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedKeyColorList {
    pub id: String,
    pub name: String,
    pub colors: Vec<KeyColor>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// A real catalog id, or a saved custom theme's, at all times — even while `generated` is what is actually
    /// shown — so switching the generated rotation off falls back to the theme that was chosen before it was
    /// turned on.
    pub theme: String,
    /// `system`, `light` or `dark`.
    pub mode: String,
    /// `Some(true)` for a manual dark mode, `Some(false)` for a manual light one, `None` when the device decides.
    pub dark: Option<bool>,
    pub rotation: Rotation,
    /// `Some` exactly while `rotation.generated.enabled`: what a page actually applies then, in place of `theme`.
    pub generated: Option<GeneratedPalette>,
    /// `Some` exactly while `rotation.generated.enabled` *and* at least one rotation tick has happened since it
    /// was turned on — the one the rotation just moved on from, so the dialog can still offer to save it even
    /// after `generated` itself has already moved to a fresh draw. See [`PREVIOUS_GENERATED_KEY`].
    pub previous_generated: Option<GeneratedPalette>,
    /// The full record for `theme`, whenever it names a saved custom theme rather than a catalog one — sent
    /// inline for the same reason `generated` is: a custom theme's colours exist nowhere but this one saved
    /// record (unlike a catalog theme, compiled into every frontend build and resolved there by plain id), so a
    /// page that doesn't ask for anything beyond `get_appearance`/the change event still shows it correctly
    /// without a separate fetch-and-cache dance (and the staleness that would risk: a theme saved and selected
    /// from one window reaching another's `applyAppearance` before that window's own cache of the saved list
    /// happened to be refreshed).
    pub custom: Option<CustomTheme>,
}

impl Appearance {
    fn new(theme: String, mode: String, rotation: Rotation, generated: Option<GeneratedPalette>, previous_generated: Option<GeneratedPalette>, custom: Option<CustomTheme>) -> Self {
        let dark = match mode.as_str() {
            "dark" => Some(true),
            "light" => Some(false),
            _ => None,
        };
        Appearance { theme, mode, dark, rotation, generated, previous_generated, custom }
    }
}

/// What the windows are told and code snippets are made from: kept here so a snippet needn't ask the database.
static CURRENT: Mutex<Option<Appearance>> = Mutex::new(None);
/// When the rotation is next due (`None`: not scheduled yet).
static NEXT_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn remember(appearance: &Appearance) {
    *CURRENT.lock().unwrap() = Some(appearance.clone());
}

/// Starts (or restarts) the wait for the next rotation.
fn schedule(rotation: &Rotation) {
    *NEXT_AT.lock().unwrap() = if rotation.enabled { rotation.interval().ok().map(|d| Instant::now() + d) } else { None };
}

/// The css a page gets so that its form controls and scrollbars follow a manual mode (`None` when the device decides).
pub fn color_scheme_css() -> Option<String> {
    let dark = CURRENT.lock().unwrap().as_ref()?.dark?;
    Some(format!(":root {{ color-scheme: {}; }}\n", if dark { "dark" } else { "light" }))
}

/// A theme id is one of the catalog's (`THEME_IDS`).
pub fn valid_theme(id: &str) -> bool {
    THEME_IDS.contains(&id)
}

pub fn valid_mode(mode: &str) -> bool {
    MODES.contains(&mode)
}

/// The theme that follows `current` in a rotation (`random`: a number to choose with, so the choice can be tested). A theme that is not in
/// `ids` (one that was removed) starts at the first, or — going down — the last.
pub fn next_theme(current: &str, mode: &str, ids: &[&str], random: u64) -> String {
    let n = ids.len();
    let at = ids.iter().position(|id| *id == current);
    let index = match mode {
        "descending" => at.map_or(n - 1, |i| (i + n - 1) % n),
        "random" if n > 1 => {
            let mut k = (random % (n as u64 - 1)) as usize;
            if at.is_some_and(|i| k >= i) {
                k += 1;
            }
            k
        }
        "random" => 0,
        _ => at.map_or(0, |i| (i + 1) % n),
    };
    ids[index].to_string()
}

// ─── Generated colours: made up near a list of key hues instead of picked from the catalog ──────────────────────

/// Full-saturation RGB, in the order a generated rotation cycles through them by default — "the next one of these
/// six colours", always forward, never ascending/descending/random (those only mean something for a fixed list).
/// "Teal" here is cyan (0, 255, 255): the six are the RGB colour wheel's primaries and secondaries, evenly spaced,
/// so a person's own "close to red" / "close to yellow" reads as adjacent stops on the same wheel. **This is only
/// the *default*** — see "Editable seed colours" below: the list actually in use is [`read_key_colors`]'s, which
/// falls back to exactly this (via [`default_key_colors`]) until the person changes it.
pub const KEY_COLORS: [(u8, u8, u8); 6] = [(255, 0, 0), (255, 255, 0), (0, 255, 0), (0, 255, 255), (0, 0, 255), (255, 0, 255)];
pub const KEY_COLOR_NAMES: [&str; 6] = ["Red", "Yellow", "Green", "Teal", "Blue", "Magenta"];
const DEFAULT_SPREAD: u8 = 64;

/// One channel of a generated colour: `key` plus a random offset in `-spread..=spread` (`random` is reduced to
/// that range, so any `u32` drives it — how it's produced doesn't matter here, which is what makes this testable
/// without a real RNG), clamped so it never leaves 0..=255.
fn generated_channel(key: u8, spread: u8, random: u32) -> u8 {
    let span = 2 * spread as i32 + 1; // spread=0 → span=1 → offset is always 0
    let offset = (random % span as u32) as i32 - spread as i32;
    (key as i32 + offset).clamp(0, 255) as u8
}

/// The RGB drawn near `colors[key_index % colors.len()]`, each channel independently — never a hue-wheel
/// rotation, so a big spread can pull one channel toward a neighbour's while another stays put, which is what
/// "close to" means here. `colors` is never empty by the time this runs — [`read_key_colors`] guarantees it.
fn generated_rgb(colors: &[(u8, u8, u8)], key_index: usize, spread: u8, randoms: [u32; 3]) -> (u8, u8, u8) {
    let (kr, kg, kb) = colors[key_index % colors.len()];
    (generated_channel(kr, spread, randoms[0]), generated_channel(kg, spread, randoms[1]), generated_channel(kb, spread, randoms[2]))
}

fn to_hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Parses a `#rrggbb` string already checked by [`hex_color_valid`] — a malformed channel (there shouldn't be
/// one, by the time this is called) reads as `0` rather than panicking, since a seed colour is cosmetic, not
/// something worth crashing the rotation's background task over.
fn from_hex(s: &str) -> (u8, u8, u8) {
    let byte = |slice: &str| u8::from_str_radix(slice, 16).unwrap_or(0);
    (byte(&s[1..3]), byte(&s[3..5]), byte(&s[5..7]))
}

/// The compiled-in six, as the same `{name, color}` shape a saved or edited list has — what "revert to the
/// default" puts back, and what a fresh install starts from.
fn default_key_colors() -> Vec<KeyColor> {
    KEY_COLOR_NAMES.iter().zip(KEY_COLORS.iter()).map(|(&name, &rgb)| KeyColor { name: name.to_string(), color: to_hex(rgb) }).collect()
}

/// The key colours a generated rotation is currently drawing near — what was last saved with [`set_key_colors`],
/// or the compiled-in default when nothing was (a fresh install, or the stored value is somehow empty/malformed:
/// treated the same as "nothing saved" rather than refusing to rotate at all).
async fn read_key_colors(pool: &sqlx::SqlitePool) -> Vec<KeyColor> {
    get_setting(pool, KEY_COLORS_KEY)
        .await
        .and_then(|json| serde_json::from_str::<Vec<KeyColor>>(&json).ok())
        .filter(|list| !list.is_empty())
        .unwrap_or_else(default_key_colors)
}

/// Every key-colour list saved so far (`[]` when none has been) — `list_saved_key_color_lists` and
/// `save_key_color_list`/`delete_key_color_list` all go through this rather than each keeping their own copy of
/// how the list is stored, the same pattern `read_custom_themes` already follows.
async fn read_saved_key_color_lists(pool: &sqlx::SqlitePool) -> Vec<SavedKeyColorList> {
    get_setting(pool, SAVED_KEY_COLOR_LISTS_KEY).await.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

/// A key-colour list must have at least one colour (`generated_rgb`'s `% len()` would panic at zero) and at most
/// [`MAX_KEY_COLORS`], and every colour needs a non-empty name (at most [`MAX_KEY_COLOR_NAME_LEN`] characters) and
/// a real `#rrggbb` value.
fn validate_key_colors(colors: &[KeyColor]) -> Result<(), String> {
    if colors.is_empty() {
        return Err("There must be at least one colour.".to_string());
    }
    if colors.len() > MAX_KEY_COLORS {
        return Err(format!("At most {MAX_KEY_COLORS} colours."));
    }
    for c in colors {
        if c.name.trim().is_empty() {
            return Err("Every colour needs a name.".to_string());
        }
        if c.name.chars().count() > MAX_KEY_COLOR_NAME_LEN {
            return Err(format!("A colour's name is at most {MAX_KEY_COLOR_NAME_LEN} characters."));
        }
        if !hex_color_valid(&c.color) {
            return Err(format!("'{}' isn't a colour of the form #rrggbb.", c.name));
        }
    }
    Ok(())
}

/// `a` moved `t` of the way toward `b` (0.0 stays `a`, 1.0 becomes `b`), per channel.
fn blend((ar, ag, ab): (u8, u8, u8), (br, bg, bb): (u8, u8, u8), t: f64) -> (u8, u8, u8) {
    let mix = |a: u8, b: u8| (a as f64 + (b as f64 - a as f64) * t).round().clamp(0.0, 255.0) as u8;
    (mix(ar, br), mix(ag, bg), mix(ab, bb))
}

/// The WCAG relative luminance of an sRGB colour (0.0 black to 1.0 white) — what a contrast ratio is built from.
fn luminance((r, g, b): (u8, u8, u8)) -> f64 {
    let lin = |c: u8| {
        let c = c as f64 / 255.0;
        if c <= 0.039_28 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/// The WCAG contrast ratio between two colours (1.0 no difference, 21.0 black on white).
fn contrast_ratio(a: (u8, u8, u8), b: (u8, u8, u8)) -> f64 {
    let (l1, l2) = (luminance(a), luminance(b));
    let (hi, lo) = if l1 >= l2 { (l1, l2) } else { (l2, l1) };
    (hi + 0.05) / (lo + 0.05)
}

/// Black or white, whichever contrasts more with `bg` — used for text on a colour this module made up itself,
/// rather than a hand-picked hex value that might not read well against every colour a random draw can produce.
fn readable_text_on(bg: (u8, u8, u8)) -> (u8, u8, u8) {
    const BLACK: (u8, u8, u8) = (0, 0, 0);
    const WHITE: (u8, u8, u8) = (255, 255, 255);
    if contrast_ratio(bg, BLACK) >= contrast_ratio(bg, WHITE) { BLACK } else { WHITE }
}

/// The same bar `fg`/`bg` already clears (checked by `a_generated_palettes_text_always_contrasts_with_its_background`)
/// — the smallest contrast a colour used as real body text is expected to have against its own background.
const TEXT_CONTRAST_MIN: f64 = 4.5;

/// `rgb`, or a version of it blended toward whichever pole (black or white) is farther from `bg`'s own luminance —
/// reported live: a generated palette drawn near Green (and, by the same reasoning, Yellow) has an `accent` whose
/// luminance is *close to white's own*, so text coloured with the raw, vivid `accent` reads fine on a dark
/// background (green-on-black is the classic high-contrast pairing) but is nearly unreadable on a light one, where
/// this module's own `accent` is deliberately used as literal text/icon colour in a few places (`App.css`'s
/// `.link-button`, `.group-toggle`, `.tab-text-bullet`; `notes.css`'s badges) rather than as a button's own
/// background (where `accent_fg` is computed against it directly and this problem doesn't arise). If `rgb` already
/// clears [`TEXT_CONTRAST_MIN`] against `bg`, it's returned exactly as it is — true for most key colours in most
/// modes, since only a hue whose own luminance sits close to `bg`'s (Green/Yellow in light mode; conversely a very
/// dark hue like Blue in dark mode, though `bg` there is already close to black so this is less often the tighter
/// case) needs any adjustment at all. Blending stops the moment the bar is cleared, so the hue is nudged no further
/// than it has to be — never diluted all the way to a flat black or white — and the loop is bounded (`t` cannot
/// exceed 1.0, at which point `candidate` **is** the pole itself, whose contrast against any `bg` this module ever
/// produces — itself always within ~30% of white or black — comfortably clears 4.5:1, so the loop always ends).
fn readable_variant_of(rgb: (u8, u8, u8), bg: (u8, u8, u8)) -> (u8, u8, u8) {
    if contrast_ratio(rgb, bg) >= TEXT_CONTRAST_MIN {
        return rgb;
    }
    let pole = if luminance(bg) > 0.5 { (0, 0, 0) } else { (255, 255, 255) };
    let mut t = 0.05;
    loop {
        let candidate = blend(rgb, pole, t);
        if contrast_ratio(candidate, bg) >= TEXT_CONTRAST_MIN || t >= 1.0 {
            return candidate;
        }
        t += 0.05;
    }
}

/// Builds a full light+dark palette around one drawn-near-a-key RGB. The background is that colour alpha-blended
/// over white (light) or black (dark) — kept to a modest alpha so the background stays close to white/black the
/// way every hand-made theme's does, which is also what keeps the contrast checks below comfortably passed for
/// *any* key colour and spread rather than needing per-theme tuning: blending a low-luminance key (blue, at
/// spread 0, has a luminance under 0.01) at up to ~30% onto black never approaches a lightness where black text
/// would start to compete, and blending a high-luminance key (yellow, over 0.9) at up to ~30% onto white never
/// approaches one where white text would. `fg`/`accent_fg` are then chosen for contrast rather than assumed.
/// `muted`/`panel`/`border`/`hover` are plain grey steps between `bg` and `fg` — neutral chrome around a coloured
/// background and a vivid, undiluted accent (the key colour itself, not blended), the same shape every catalog
/// theme has (`bg`/`panel`/`accent`/`fg`, its swatch's four dots).
fn palette_for(rgb: (u8, u8, u8), dark: bool) -> ThemeColors {
    let base = if dark { (0, 0, 0) } else { (255, 255, 255) };
    let bg = blend(base, rgb, if dark { 0.22 } else { 0.10 });
    let fg = readable_text_on(bg);
    let accent = rgb;
    let accent_fg = readable_text_on(accent);
    let accent_text = readable_variant_of(rgb, bg);
    ThemeColors {
        bg: to_hex(bg),
        fg: to_hex(fg),
        muted: to_hex(blend(bg, fg, 0.45)),
        border: to_hex(blend(bg, fg, 0.30)),
        accent: to_hex(accent),
        accent_fg: to_hex(accent_fg),
        accent_text: to_hex(accent_text),
        panel: to_hex(blend(bg, fg, 0.06)),
        hover: to_hex(blend(bg, fg, 0.12)),
    }
}

/// A fresh `GeneratedPalette` for `key_index` of `colors`, drawn with `randoms` (three offsets — see `generated_rgb`).
fn generated_palette(colors: &[(u8, u8, u8)], key_index: usize, spread: u8, randoms: [u32; 3]) -> GeneratedPalette {
    let rgb = generated_rgb(colors, key_index, spread, randoms);
    GeneratedPalette { key_index: key_index as u8, light: palette_for(rgb, false), dark: palette_for(rgb, true) }
}

/// Three offsets to draw a generated colour's channels with, from real randomness — split, rather than one call
/// per channel, so a single spin of the RNG covers all three.
fn random_channel_offsets() -> [u32; 3] {
    let bits = uuid::Uuid::new_v4().as_u128();
    [(bits & 0xffff_ffff) as u32, ((bits >> 32) & 0xffff_ffff) as u32, ((bits >> 64) & 0xffff_ffff) as u32]
}

async fn get_setting(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1").bind(key).fetch_optional(pool).await.ok().flatten()
}

/// Every custom theme saved so far (`[]` when none has been). `read` and the `list_custom_themes` command both
/// go through this rather than each keeping their own copy of how the list is stored.
async fn read_custom_themes(pool: &sqlx::SqlitePool) -> Vec<CustomTheme> {
    get_setting(pool, CUSTOM_THEMES_KEY).await.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

async fn read(pool: &sqlx::SqlitePool) -> Appearance {
    let customs = read_custom_themes(pool).await;
    let theme = get_setting(pool, THEME_KEY)
        .await
        .filter(|t| valid_theme(t) || customs.iter().any(|c| &c.id == t))
        .unwrap_or_else(|| DEFAULT_THEME.to_string());
    let custom = customs.into_iter().find(|c| c.id == theme);
    let mode = get_setting(pool, MODE_KEY).await.filter(|m| valid_mode(m)).unwrap_or_else(|| "system".to_string());
    let rotation = get_setting(pool, ROTATION_KEY).await.and_then(|json| serde_json::from_str::<Rotation>(&json).ok()).filter(|r| r.interval().is_ok()).unwrap_or_default();
    let (generated, previous_generated) = if rotation.generated.enabled {
        let generated = get_setting(pool, GENERATED_KEY).await.and_then(|json| serde_json::from_str::<GeneratedPalette>(&json).ok());
        let previous = get_setting(pool, PREVIOUS_GENERATED_KEY).await.and_then(|json| serde_json::from_str::<GeneratedPalette>(&json).ok());
        (generated, previous)
    } else {
        (None, None)
    };
    Appearance::new(theme, mode, rotation, generated, previous_generated, custom)
}

/// Draws a fresh palette for the next key colour after `previous` (`None`: the first one, key 0), from whichever
/// list of key colours is active right now (`read_key_colors` — the compiled-in default, or whatever was saved
/// with `set_key_colors`), persists it and returns it — the one place both `rotate_if_due` and turning the
/// generated rotation on call into, so a person is never left looking at "generated colours, enabled" with
/// nothing actually drawn yet.
async fn draw_generated(pool: &sqlx::SqlitePool, previous: Option<&GeneratedPalette>, spread: u8) -> Result<GeneratedPalette, String> {
    let colors: Vec<(u8, u8, u8)> = read_key_colors(pool).await.iter().map(|k| from_hex(&k.color)).collect();
    let key_index = previous.map_or(0, |p| (p.key_index as usize + 1) % colors.len());
    let palette = generated_palette(&colors, key_index, spread, random_channel_offsets());
    write(pool, GENERATED_KEY, &serde_json::to_string(&palette).map_err(|e| e.to_string())?).await?;
    Ok(palette)
}

async fn write(pool: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query("INSERT INTO global_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts the manual mode on the app itself, which is what the webviews' `prefers-color-scheme` follows (desktop).
fn apply_to_app(app: &AppHandle, appearance: &Appearance) {
    #[cfg(desktop)]
    {
        let theme = match appearance.dark {
            Some(true) => Some(tauri::Theme::Dark),
            Some(false) => Some(tauri::Theme::Light),
            None => None,
        };
        app.set_theme(theme);
    }
    #[cfg(not(desktop))]
    let _ = (app, appearance);
}

/// The appearance changed: remembered, put on the app, and every window told.
fn changed(app: &AppHandle, appearance: &Appearance) {
    remember(appearance);
    apply_to_app(app, appearance);
    crate::window_host::emit_to_all(app, EVENT, appearance);
}

/// At start: reads what was chosen, remembers it, puts it on the app and starts the rotation's clock.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppDbState>();
    let appearance = tauri::async_runtime::block_on(read(&state.pool));
    remember(&appearance);
    apply_to_app(app, &appearance);
    schedule(&appearance.rotation);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            rotate_if_due(&app).await;
        }
    });
}

/// One look of the rotation's clock: moves to the next theme — or draws a fresh generated colour — when the
/// interval has passed.
async fn rotate_if_due(app: &AppHandle) {
    let Some(current) = CURRENT.lock().unwrap().clone() else { return };
    if !current.rotation.enabled {
        return;
    }
    {
        let mut next_at = NEXT_AT.lock().unwrap();
        match *next_at {
            None => {
                *next_at = current.rotation.interval().ok().map(|d| Instant::now() + d);
                return;
            }
            Some(at) if Instant::now() < at => return,
            Some(_) => {}
        }
    }
    let state = app.state::<AppDbState>();
    schedule(&current.rotation);
    if current.rotation.generated.enabled {
        // The one it's about to replace becomes "the previous one" — a real rotation tick, not merely the
        // setting being toggled or re-saved (see `PREVIOUS_GENERATED_KEY`'s own doc comment).
        if let Some(previous) = &current.generated {
            let Ok(json) = serde_json::to_string(previous) else { return };
            if write(&state.pool, PREVIOUS_GENERATED_KEY, &json).await.is_err() {
                return;
            }
        }
        let Ok(generated) = draw_generated(&state.pool, current.generated.as_ref(), current.rotation.generated.spread).await else { return };
        // `theme` (and so `custom`) is untouched by a generated tick — only `generated` itself moves on.
        changed(app, &Appearance::new(current.theme.clone(), current.mode.clone(), current.rotation.clone(), Some(generated), current.generated.clone(), current.custom.clone()));
        return;
    }
    // `next_theme` only ever picks from the compiled-in catalog (`THEME_IDS`), never a custom id.
    let theme = next_theme(&current.theme, &current.rotation.mode, THEME_IDS, uuid::Uuid::new_v4().as_u128() as u64);
    if write(&state.pool, THEME_KEY, &theme).await.is_err() {
        return;
    }
    changed(app, &Appearance::new(theme, current.mode.clone(), current.rotation.clone(), None, None, None));
}

#[tauri::command]
pub async fn get_appearance(state: tauri::State<'_, AppDbState>) -> Result<Appearance, String> {
    Ok(read(&state.pool).await)
}

/// The ids of the themes, in the order a rotation goes through them.
#[tauri::command]
pub fn list_themes() -> Vec<&'static str> {
    THEME_IDS.to_vec()
}

/// The key colours a generated rotation is currently drawing near, in the order it cycles through them — for the
/// dialog's own legend and its editable list, rather than a second, hand-kept copy on the frontend that could
/// drift from the backend's own. Any window (the same read-only trust level as `list_themes`).
#[tauri::command]
pub async fn get_key_colors(state: tauri::State<'_, AppDbState>) -> Result<Vec<KeyColor>, String> {
    Ok(read_key_colors(&state.pool).await)
}

/// The compiled-in six key colours — what "Revert to the default colours" puts back, and what a fresh install
/// starts from. Separate from `get_key_colors` so the dialog can show *both* at once (what's active, and what
/// reverting would produce) without the frontend keeping its own copy of the default.
#[tauri::command]
pub fn get_default_key_colors() -> Vec<KeyColor> {
    default_key_colors()
}

/// Sets the key colours a generated rotation draws near from now on. **Admin-app only** — editing the seed
/// colours is editing the rotation's own configuration, the same trust level `set_appearance_rotation` already
/// keeps to the admin-app alone. Takes effect on the *next* drawn colour, same as changing the spread does: the
/// colour currently on screen (if generated colours are on) is left exactly as it is, so saving a changed list
/// doesn't recolour the window out from under the person for no reason they asked for.
#[tauri::command]
pub async fn set_key_colors(window: crate::window_host::CallerWindow, state: tauri::State<'_, AppDbState>, colors: Vec<KeyColor>) -> Result<Vec<KeyColor>, String> {
    crate::window_host::require_admin(&window, "set_key_colors")?;
    validate_key_colors(&colors)?;
    write(&state.pool, KEY_COLORS_KEY, &serde_json::to_string(&colors).map_err(|e| e.to_string())?).await?;
    Ok(colors)
}

/// Every list of key colours the person has saved so far (`[]` when none has been). Any window (the same
/// read-only trust level as `list_custom_themes`).
#[tauri::command]
pub async fn list_saved_key_color_lists(state: tauri::State<'_, AppDbState>) -> Result<Vec<SavedKeyColorList>, String> {
    Ok(read_saved_key_color_lists(&state.pool).await)
}

/// Saves `colors` as a new named list, so it can be picked again later. **Admin-app only** — the key-colour
/// counterpart of `save_custom_theme`, kept to the same trust level as every other part of editing the rotation's
/// own configuration (unlike `save_custom_theme` itself, which *is* open to any window: saving a plain theme
/// isn't configuring the rotation, only remembering a colour scheme to look at — a different thing).
#[tauri::command]
pub async fn save_key_color_list(window: crate::window_host::CallerWindow, state: tauri::State<'_, AppDbState>, name: String, colors: Vec<KeyColor>) -> Result<SavedKeyColorList, String> {
    crate::window_host::require_admin(&window, "save_key_color_list")?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Give the list a name.".to_string());
    }
    if trimmed.chars().count() > MAX_SAVED_KEY_COLOR_LIST_NAME_LEN {
        return Err(format!("A list's name is at most {MAX_SAVED_KEY_COLOR_LIST_NAME_LEN} characters."));
    }
    validate_key_colors(&colors)?;
    let mut lists = read_saved_key_color_lists(&state.pool).await;
    let saved = SavedKeyColorList { id: format!("keycolors-{}", uuid::Uuid::new_v4()), name: trimmed.to_string(), colors };
    lists.push(saved.clone());
    write(&state.pool, SAVED_KEY_COLOR_LISTS_KEY, &serde_json::to_string(&lists).map_err(|e| e.to_string())?).await?;
    Ok(saved)
}

/// Removes a saved key-colour list (not the *active* one — see `set_key_colors` for that; this only forgets a
/// saved preset). **Admin-app only**, same as the rest of editing this configuration.
#[tauri::command]
pub async fn delete_key_color_list(window: crate::window_host::CallerWindow, state: tauri::State<'_, AppDbState>, id: String) -> Result<(), String> {
    crate::window_host::require_admin(&window, "delete_key_color_list")?;
    let mut lists = read_saved_key_color_lists(&state.pool).await;
    lists.retain(|l| l.id != id);
    write(&state.pool, SAVED_KEY_COLOR_LISTS_KEY, &serde_json::to_string(&lists).map_err(|e| e.to_string())?).await?;
    Ok(())
}

/// Chooses the theme and the mode of the whole app. **Any window may** — and a rotation that is on goes on, from the theme chosen, with its
/// interval starting again.
#[tauri::command]
pub async fn set_appearance(app: AppHandle, state: tauri::State<'_, AppDbState>, theme: String, mode: String) -> Result<Appearance, String> {
    if !valid_theme(&theme) && !read_custom_themes(&state.pool).await.iter().any(|c| c.id == theme) {
        return Err("That isn't the name of a theme (list_themes/list_custom_themes say which there are).".to_string());
    }
    if !valid_mode(&mode) {
        return Err("The mode is system, light or dark.".to_string());
    }
    write(&state.pool, THEME_KEY, &theme).await?;
    write(&state.pool, MODE_KEY, &mode).await?;
    let now = read(&state.pool).await;
    schedule(&now.rotation);
    let appearance = Appearance::new(theme, mode, now.rotation, now.generated, now.previous_generated, now.custom);
    changed(&app, &appearance);
    Ok(appearance)
}

/// Sets the rotation through the themes. **Admin-app only.** Turning the generated colours on (from off, or for
/// the very first time) draws one at once — otherwise the dialog would show "on" with nothing actually chosen —
/// but merely re-saving other rotation settings (the interval, say) while it's already on leaves the current
/// colour alone: it isn't the point of pressing that a colour someone is looking at changes underneath them.
#[tauri::command]
pub async fn set_appearance_rotation(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    rotation: Rotation,
) -> Result<Appearance, String> {
    crate::window_host::require_admin(&window, "set_appearance_rotation")?;
    rotation.interval()?;
    let before = read(&state.pool).await;
    write(&state.pool, ROTATION_KEY, &serde_json::to_string(&rotation).map_err(|e| e.to_string())?).await?;
    let (generated, previous_generated) = if rotation.generated.enabled {
        match before.generated {
            // Already on, merely re-saved (the interval, say): the colour someone is looking at — and what it
            // was the step before — are both left exactly as they were.
            Some(existing) if before.rotation.generated.enabled => (Some(existing), before.previous_generated),
            // Off until now, or never drawn: a fresh draw, with no "previous" yet — the person hasn't watched a
            // real rotation tick happen since, so there's nothing to offer alongside this first one.
            previous => (Some(draw_generated(&state.pool, previous.as_ref(), rotation.generated.spread).await?), None),
        }
    } else {
        (None, None)
    };
    schedule(&rotation);
    // `theme` itself is untouched by this command (only the rotation is), so `before.custom` is still accurate.
    let appearance = Appearance::new(before.theme, before.mode, rotation, generated, previous_generated, before.custom);
    changed(&app, &appearance);
    Ok(appearance)
}

fn hex_color_valid(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// A custom theme's colours must each be a plain `#rrggbb` string before they're ever trusted into a CSS
/// variable — the same caution the frontend's own `asHexColor` (`lib/appearance.ts`) already takes with
/// whatever the backend sends it, now needed in the other direction too since a *page* is the one handing this
/// module colours (`save_custom_theme`) rather than this module making them up itself (`palette_for`, whose own
/// output is trusted because every step between a key hue and a final hex string is this module's own code).
fn validate_theme_colors(c: &ThemeColors) -> Result<(), String> {
    for (label, value) in
        [("bg", &c.bg), ("fg", &c.fg), ("muted", &c.muted), ("border", &c.border), ("accent", &c.accent), ("accent_fg", &c.accent_fg), ("accent_text", &c.accent_text), ("panel", &c.panel), ("hover", &c.hover)]
    {
        if !hex_color_valid(value) {
            return Err(format!("'{label}' isn't a colour of the form #rrggbb."));
        }
    }
    Ok(())
}

/// Every custom theme the person has saved — any window (the same read-only trust level as `list_themes`).
#[tauri::command]
pub async fn list_custom_themes(state: tauri::State<'_, AppDbState>) -> Result<Vec<CustomTheme>, String> {
    Ok(read_custom_themes(&state.pool).await)
}

/// Saves `light`/`dark` as a new custom theme named `name`, so it can be picked again later like any catalog
/// one. Any window may — no more sensitive than `set_appearance` itself, which the person already decided a web
/// app may call; this just remembers a choice for next time rather than applying one now. Asked for directly: a
/// *generated* colour scheme (see "Generated colours" above) has no other way to survive the rotation moving on,
/// or the app closing.
#[tauri::command]
pub async fn save_custom_theme(state: tauri::State<'_, AppDbState>, name: String, light: ThemeColors, dark: ThemeColors) -> Result<CustomTheme, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Give the theme a name.".to_string());
    }
    if trimmed.chars().count() > MAX_CUSTOM_THEME_NAME_LEN {
        return Err(format!("A theme's name is at most {MAX_CUSTOM_THEME_NAME_LEN} characters."));
    }
    validate_theme_colors(&light)?;
    validate_theme_colors(&dark)?;
    let mut themes = read_custom_themes(&state.pool).await;
    let custom = CustomTheme { id: format!("custom-{}", uuid::Uuid::new_v4()), name: trimmed.to_string(), light, dark };
    themes.push(custom.clone());
    write(&state.pool, CUSTOM_THEMES_KEY, &serde_json::to_string(&themes).map_err(|e| e.to_string())?).await?;
    Ok(custom)
}

/// Removes a saved custom theme. If it's the one currently active anywhere, every window is told at once (the
/// same graceful fallback `read` already gives a theme id nothing recognizes any more — `theme` field wins the
/// `valid_theme`/custom-list check and falls back to the default), rather than waiting for the next `get_appearance`.
#[tauri::command]
pub async fn delete_custom_theme(app: AppHandle, state: tauri::State<'_, AppDbState>, id: String) -> Result<(), String> {
    let mut themes = read_custom_themes(&state.pool).await;
    themes.retain(|t| t.id != id);
    write(&state.pool, CUSTOM_THEMES_KEY, &serde_json::to_string(&themes).map_err(|e| e.to_string())?).await?;
    changed(&app, &read(&state.pool).await);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        assert!(valid_theme("dune-noon"));
        assert!(valid_theme(DEFAULT_THEME));
        assert!(!valid_theme(""));
        assert!(!valid_theme("Dune Noon"));
        assert!(!valid_theme("a/b"));
        assert!(valid_mode("dark") && valid_mode("light") && valid_mode("system"));
        assert!(!valid_mode("auto"));
    }

    #[test]
    fn the_theme_list_is_the_catalogs() {
        let catalog = include_str!("../../src/lib/themes.ts");
        let ids: Vec<&str> = catalog
            .lines()
            .filter_map(|l| l.trim_start().strip_prefix("theme('"))
            .filter_map(|rest| rest.split('\'').next())
            .collect();
        assert_eq!(ids, THEME_IDS, "themes.ts and appearance.rs must list the same themes in the same order");
        assert!(THEME_IDS.contains(&DEFAULT_THEME));
        let mut sorted = THEME_IDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), THEME_IDS.len(), "no id twice");
    }

    #[test]
    fn a_manual_mode_says_whether_it_is_dark() {
        let r = Rotation::default();
        assert_eq!(Appearance::new("x".into(), "dark".into(), r.clone(), None, None, None).dark, Some(true));
        assert_eq!(Appearance::new("x".into(), "light".into(), r.clone(), None, None, None).dark, Some(false));
        assert_eq!(Appearance::new("x".into(), "system".into(), r, None, None, None).dark, None);
    }

    #[test]
    fn the_reserved_keys_are_the_ones_this_module_writes() {
        for key in [THEME_KEY, MODE_KEY, ROTATION_KEY, GENERATED_KEY, PREVIOUS_GENERATED_KEY, CUSTOM_THEMES_KEY, KEY_COLORS_KEY, SAVED_KEY_COLOR_LISTS_KEY] {
            assert!(key.starts_with(RESERVED_PREFIX));
        }
    }

    #[test]
    fn a_rotation_goes_through_the_catalog_both_ways_and_wraps() {
        let ids = ["a", "b", "c"];
        assert_eq!(next_theme("a", "ascending", &ids, 0), "b");
        assert_eq!(next_theme("c", "ascending", &ids, 0), "a");
        assert_eq!(next_theme("a", "descending", &ids, 0), "c");
        assert_eq!(next_theme("b", "descending", &ids, 0), "a");
        assert_eq!(next_theme("gone", "ascending", &ids, 0), "a", "a theme that isn't there starts at the first");
        assert_eq!(next_theme("gone", "descending", &ids, 0), "c");
    }

    #[test]
    fn a_random_rotation_never_stays_and_can_reach_every_other_theme() {
        let ids = ["a", "b", "c", "d"];
        let mut seen = std::collections::HashSet::new();
        for random in 0..40u64 {
            let next = next_theme("c", "random", &ids, random);
            assert_ne!(next, "c");
            seen.insert(next);
        }
        assert_eq!(seen.len(), 3, "{seen:?}");
        assert_eq!(next_theme("a", "random", &["a"], 7), "a", "a catalog of one");
    }

    #[test]
    fn the_interval_is_checked_and_never_shorter_than_one_second() {
        let r = |unit: &str, every: u32| Rotation { enabled: true, mode: "random".into(), unit: unit.into(), every, generated: GeneratedColors::default() };
        assert_eq!(r("seconds", 1).interval().unwrap(), Duration::from_secs(1), "a one-second interval is allowed, to make testing quick");
        assert!(r("seconds", 0).interval().unwrap_err().contains("at least 1 second"), "singular, not '1 seconds'");
        assert_eq!(r("seconds", 30).interval().unwrap(), Duration::from_secs(30));
        assert_eq!(r("minutes", 1).interval().unwrap(), Duration::from_secs(60));
        assert_eq!(r("hours", 2).interval().unwrap(), Duration::from_secs(7200));
        assert_eq!(r("days", 3).interval().unwrap(), Duration::from_secs(259_200));
        assert!(r("weeks", 1).interval().is_err());
        assert!(r("days", 400).interval().is_err());
        assert!(Rotation { mode: "sideways".into(), ..r("days", 1) }.interval().is_err());
        assert!(Rotation::default().interval().is_ok(), "what starts as the default is valid");
    }

    #[test]
    fn a_generated_channel_never_leaves_its_spread_or_0_255() {
        for key in [0u8, 1, 254, 255] {
            for spread in [0u8, 1, 64, 255] {
                for random in [0u32, 1, 1000, u32::MAX] {
                    let c = generated_channel(key, spread, random) as i32;
                    assert!(c >= (key as i32 - spread as i32).max(0) && c <= (key as i32 + spread as i32).min(255), "key={key} spread={spread} random={random} got {c}");
                }
            }
        }
        // spread 0 always lands exactly on the key, whatever the randomness.
        assert_eq!(generated_channel(128, 0, 0), 128);
        assert_eq!(generated_channel(128, 0, u32::MAX), 128);
    }

    #[test]
    fn key_colours_are_six_and_evenly_spaced_rgb_primaries_and_secondaries() {
        assert_eq!(KEY_COLORS.len(), 6);
        assert_eq!(KEY_COLOR_NAMES.len(), 6);
        for (r, g, b) in KEY_COLORS {
            // every key is fully saturated: each channel is 0 or 255, and exactly two of the three are 255 (or one).
            assert!([r, g, b].iter().all(|c| *c == 0 || *c == 255));
        }
        let mut sorted = KEY_COLORS.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 6, "no key colour twice");
    }

    #[test]
    fn drawing_generated_colours_cycles_through_the_six_keys_in_order() {
        let mut palette = generated_palette(&KEY_COLORS, 0, 64, [0, 0, 0]);
        for expected in [1u8, 2, 3, 4, 5, 0, 1] {
            let key_index = (palette.key_index as usize + 1) % KEY_COLORS.len();
            palette = generated_palette(&KEY_COLORS, key_index, 64, [0, 0, 0]);
            assert_eq!(palette.key_index, expected);
        }
    }

    #[test]
    fn a_generated_palettes_text_always_contrasts_with_its_background() {
        // Every key colour, both extremes of spread, both modes: the automatically-chosen text must clear WCAG AA
        // (4.5:1) against the background, the accent's own text must clear the button-text minimum (3.6:1), and
        // accent_text — the stand-in used wherever the app's own CSS puts the accent colour directly on the page's
        // background as literal text (a link, a badge, a tab's bullet) — must clear the same 4.5:1 bar `fg` does,
        // the fix for a real report (Green's own light-mode accent, close to white's own luminance, was close to
        // unreadable as text on a light background even though it's a perfectly fine, vivid *button* background,
        // where accent_fg is computed against it directly and this doesn't arise). All three are computed from the
        // actual colour rather than fixed like a hand-made theme's, since a hand-picked value can't be right for
        // every colour a random draw can produce.
        for key_index in 0..KEY_COLORS.len() {
            for spread in [0u8, 64, 128, 255] {
                for randoms in [[0u32, 0, 0], [u32::MAX, u32::MAX, u32::MAX], [12345, 999_999, 42]] {
                    let palette = generated_palette(&KEY_COLORS, key_index, spread, randoms);
                    for colors in [&palette.light, &palette.dark] {
                        let bg = hex_to_rgb(&colors.bg);
                        let fg = hex_to_rgb(&colors.fg);
                        assert!(contrast_ratio(bg, fg) >= 4.5, "key={key_index} spread={spread} bg={} fg={}: {:.2}", colors.bg, colors.fg, contrast_ratio(bg, fg));
                        let accent = hex_to_rgb(&colors.accent);
                        let accent_fg = hex_to_rgb(&colors.accent_fg);
                        assert!(contrast_ratio(accent, accent_fg) >= 3.6, "key={key_index} spread={spread} accent={} accentFg={}: {:.2}", colors.accent, colors.accent_fg, contrast_ratio(accent, accent_fg));
                        let accent_text = hex_to_rgb(&colors.accent_text);
                        assert!(
                            contrast_ratio(bg, accent_text) >= TEXT_CONTRAST_MIN,
                            "key={key_index} spread={spread} bg={} accentText={}: {:.2}",
                            colors.bg,
                            colors.accent_text,
                            contrast_ratio(bg, accent_text)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_colour_that_already_reads_fine_is_returned_unchanged_and_one_that_does_not_is_adjusted_just_enough() {
        // Blue's own light-mode background is close to white, and Blue itself is dark — already plenty readable as
        // text on it, so nothing should be touched.
        let white_ish = (245, 245, 255);
        let blue = (0, 0, 255);
        assert!(contrast_ratio(blue, white_ish) >= TEXT_CONTRAST_MIN, "the test's own premise");
        assert_eq!(readable_variant_of(blue, white_ish), blue);
        // Pure green on a near-white background is the reported case: close to unreadable unadjusted, and the
        // fix must actually move it, land on something that clears the bar, and never overshoot past pure black.
        let green = (0, 255, 0);
        assert!(contrast_ratio(green, white_ish) < TEXT_CONTRAST_MIN, "the test's own premise");
        let adjusted = readable_variant_of(green, white_ish);
        assert_ne!(adjusted, green, "must actually be adjusted");
        assert!(contrast_ratio(adjusted, white_ish) >= TEXT_CONTRAST_MIN);
        assert!(adjusted.1 > 0, "still recognisably green, not blended all the way to black");
    }

    #[test]
    fn hex_colours_are_checked_before_a_custom_theme_is_trusted() {
        assert!(hex_color_valid("#000000"));
        assert!(hex_color_valid("#FfAa00"));
        assert!(!hex_color_valid("000000"), "needs the #");
        assert!(!hex_color_valid("#00000"), "too short");
        assert!(!hex_color_valid("#0000000"), "too long");
        assert!(!hex_color_valid("#gggggg"), "not hex digits");
        assert!(!hex_color_valid(""));
        let good = || ThemeColors {
            bg: "#ffffff".into(),
            fg: "#000000".into(),
            muted: "#808080".into(),
            border: "#cccccc".into(),
            accent: "#d04a0b".into(),
            accent_fg: "#ffffff".into(),
            accent_text: "#d04a0b".into(),
            panel: "#f8fafc".into(),
            hover: "#f1f5f9".into(),
        };
        assert!(validate_theme_colors(&good()).is_ok());
        let mut bad = good();
        bad.accent = "not-a-colour".into();
        assert!(validate_theme_colors(&bad).unwrap_err().contains("accent"));
    }

    #[test]
    fn from_hex_and_to_hex_round_trip() {
        for rgb in [(0, 0, 0), (255, 255, 255), (18, 52, 86), (255, 0, 128)] {
            assert_eq!(from_hex(&to_hex(rgb)), rgb);
        }
    }

    #[test]
    fn the_default_key_colours_match_the_compiled_in_six() {
        let defaults = default_key_colors();
        assert_eq!(defaults.len(), 6);
        for (entry, (&name, &rgb)) in defaults.iter().zip(KEY_COLOR_NAMES.iter().zip(KEY_COLORS.iter())) {
            assert_eq!(entry.name, name);
            assert_eq!(from_hex(&entry.color), rgb);
        }
    }

    #[test]
    fn a_key_colour_list_is_checked_before_it_can_be_saved_or_made_active() {
        assert!(validate_key_colors(&[]).unwrap_err().contains("at least one"));
        let too_many: Vec<KeyColor> = (0..=MAX_KEY_COLORS).map(|i| KeyColor { name: format!("c{i}"), color: "#000000".into() }).collect();
        assert!(validate_key_colors(&too_many).unwrap_err().contains("At most"));
        assert!(validate_key_colors(&[KeyColor { name: "".into(), color: "#ffffff".into() }]).unwrap_err().contains("needs a name"));
        assert!(validate_key_colors(&[KeyColor { name: "   ".into(), color: "#ffffff".into() }]).unwrap_err().contains("needs a name"), "whitespace-only isn't a name");
        let long_name = "x".repeat(MAX_KEY_COLOR_NAME_LEN + 1);
        assert!(validate_key_colors(&[KeyColor { name: long_name, color: "#ffffff".into() }]).unwrap_err().contains("at most"));
        assert!(validate_key_colors(&[KeyColor { name: "Teal".into(), color: "cyan".into() }]).unwrap_err().contains("Teal"), "names the bad colour by its own entry's name");
        assert!(validate_key_colors(&default_key_colors()).is_ok());
        assert!(validate_key_colors(&[KeyColor { name: "Solo".into(), color: "#123456".into() }]).is_ok(), "exactly one colour is enough");
    }

    #[test]
    fn generated_rgb_and_palette_draw_from_whichever_list_is_given_them_not_always_the_compiled_in_default() {
        // A custom, two-colour list — nothing here should ever reach for `KEY_COLORS` directly.
        let custom = [(10u8, 20, 30), (200u8, 150, 100)];
        assert_eq!(generated_rgb(&custom, 0, 0, [0, 0, 0]), (10, 20, 30));
        assert_eq!(generated_rgb(&custom, 1, 0, [0, 0, 0]), (200, 150, 100));
        assert_eq!(generated_rgb(&custom, 2, 0, [0, 0, 0]), (10, 20, 30), "wraps by the custom list's own length (2), not 6");
        let palette = generated_palette(&custom, 1, 0, [0, 0, 0]);
        assert_eq!(palette.key_index, 1);
        assert_eq!(hex_to_rgb(&palette.light.accent), (200, 150, 100), "the raw accent is the drawn colour itself, undiluted");
    }

    /// Test-only inverse of `to_hex`, to check contrast against the strings a palette actually stores.
    fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
        let hex = hex.trim_start_matches('#');
        (u8::from_str_radix(&hex[0..2], 16).unwrap(), u8::from_str_radix(&hex[2..4], 16).unwrap(), u8::from_str_radix(&hex[4..6], 16).unwrap())
    }

    #[test]
    fn old_rotation_json_without_generated_still_deserializes_off() {
        let old = r#"{"enabled":true,"mode":"random","unit":"minutes","every":5}"#;
        let r: Rotation = serde_json::from_str(old).unwrap();
        assert!(!r.generated.enabled);
        assert_eq!(r.generated.spread, DEFAULT_SPREAD);
    }
}
