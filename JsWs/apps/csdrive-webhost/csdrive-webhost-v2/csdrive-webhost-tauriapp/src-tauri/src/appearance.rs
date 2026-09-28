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
//! Choosing a theme by hand doesn't stop it (it starts the interval again). **The interval is never shorter than [`MIN_INTERVAL_SECS`]**: every
//! change recolours the whole window, and anything faster than that is tiring to look at.

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
/// The keys of the global settings that only this module writes.
pub const RESERVED_PREFIX: &str = "appearance.";

pub const DEFAULT_THEME: &str = "ayran-orange";
const MODES: [&str; 3] = ["system", "light", "dark"];

/// The shortest time between two rotations: half a minute.
pub const MIN_INTERVAL_SECS: u64 = 30;
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
            return Err(format!("A theme stays at least {MIN_INTERVAL_SECS} seconds: changing the colours of the whole window faster than that is tiring to look at."));
        }
        if secs > MAX_INTERVAL_SECS {
            return Err("A theme stays at most a year.".to_string());
        }
        Ok(Duration::from_secs(secs))
    }
}

/// The eight colours a `Theme` of the catalog (`src/lib/themes.ts`'s `Palette`) has — spelled out here as its own
/// struct, rather than reusing anything theme-shaped, because a generated palette isn't one of the catalog's named
/// themes and has no `id`/`family`/`name` of its own.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub bg: String,
    pub fg: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub accent_fg: String,
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

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Appearance {
    /// A real catalog id at all times — even while `generated` is what is actually shown — so switching the
    /// generated rotation off falls back to the theme that was chosen before it was turned on.
    pub theme: String,
    /// `system`, `light` or `dark`.
    pub mode: String,
    /// `Some(true)` for a manual dark mode, `Some(false)` for a manual light one, `None` when the device decides.
    pub dark: Option<bool>,
    pub rotation: Rotation,
    /// `Some` exactly while `rotation.generated.enabled`: what a page actually applies then, in place of `theme`.
    pub generated: Option<GeneratedPalette>,
}

impl Appearance {
    fn new(theme: String, mode: String, rotation: Rotation, generated: Option<GeneratedPalette>) -> Self {
        let dark = match mode.as_str() {
            "dark" => Some(true),
            "light" => Some(false),
            _ => None,
        };
        Appearance { theme, mode, dark, rotation, generated }
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

// ─── Generated colours: made up near six key hues instead of picked from the catalog ───────────────────────────

/// Full-saturation RGB, in the order a generated rotation cycles through them — "the next one of these six
/// colours", always forward, never ascending/descending/random (those only mean something for a fixed list).
/// "Teal" here is cyan (0, 255, 255): the six are the RGB colour wheel's primaries and secondaries, evenly spaced,
/// so a person's own "close to red" / "close to yellow" reads as adjacent stops on the same wheel.
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

/// The RGB drawn near `KEY_COLORS[key_index]`, each channel independently — never a hue-wheel rotation, so a big
/// spread can pull one channel toward a neighbour's while another stays put, which is what "close to" means here.
fn generated_rgb(key_index: usize, spread: u8, randoms: [u32; 3]) -> (u8, u8, u8) {
    let (kr, kg, kb) = KEY_COLORS[key_index % KEY_COLORS.len()];
    (generated_channel(kr, spread, randoms[0]), generated_channel(kg, spread, randoms[1]), generated_channel(kb, spread, randoms[2]))
}

fn to_hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
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
    ThemeColors {
        bg: to_hex(bg),
        fg: to_hex(fg),
        muted: to_hex(blend(bg, fg, 0.45)),
        border: to_hex(blend(bg, fg, 0.30)),
        accent: to_hex(accent),
        accent_fg: to_hex(accent_fg),
        panel: to_hex(blend(bg, fg, 0.06)),
        hover: to_hex(blend(bg, fg, 0.12)),
    }
}

/// A fresh `GeneratedPalette` for `key_index`, drawn with `randoms` (three offsets — see [`generated_rgb`]).
fn generated_palette(key_index: usize, spread: u8, randoms: [u32; 3]) -> GeneratedPalette {
    let rgb = generated_rgb(key_index, spread, randoms);
    GeneratedPalette { key_index: key_index as u8, light: palette_for(rgb, false), dark: palette_for(rgb, true) }
}

/// Three offsets to draw a generated colour's channels with, from real randomness — split, rather than one call
/// per channel, so a single spin of the RNG covers all three.
fn random_channel_offsets() -> [u32; 3] {
    let bits = uuid::Uuid::new_v4().as_u128();
    [(bits & 0xffff_ffff) as u32, ((bits >> 32) & 0xffff_ffff) as u32, ((bits >> 64) & 0xffff_ffff) as u32]
}

async fn read(pool: &sqlx::SqlitePool) -> Appearance {
    async fn get(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1").bind(key).fetch_optional(pool).await.ok().flatten()
    }
    let theme = get(pool, THEME_KEY).await.filter(|t| valid_theme(t)).unwrap_or_else(|| DEFAULT_THEME.to_string());
    let mode = get(pool, MODE_KEY).await.filter(|m| valid_mode(m)).unwrap_or_else(|| "system".to_string());
    let rotation = get(pool, ROTATION_KEY).await.and_then(|json| serde_json::from_str::<Rotation>(&json).ok()).filter(|r| r.interval().is_ok()).unwrap_or_default();
    let generated = if rotation.generated.enabled { get(pool, GENERATED_KEY).await.and_then(|json| serde_json::from_str::<GeneratedPalette>(&json).ok()) } else { None };
    Appearance::new(theme, mode, rotation, generated)
}

/// Draws a fresh palette for the next key colour after `previous` (`None`: the first one, key 0 — red), persists
/// it and returns it — the one place both `rotate_if_due` and turning the generated rotation on call into, so a
/// person is never left looking at "generated colours, enabled" with nothing actually drawn yet.
async fn draw_generated(pool: &sqlx::SqlitePool, previous: Option<&GeneratedPalette>, spread: u8) -> Result<GeneratedPalette, String> {
    let key_index = previous.map_or(0, |p| (p.key_index as usize + 1) % KEY_COLORS.len());
    let palette = generated_palette(key_index, spread, random_channel_offsets());
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
        let Ok(generated) = draw_generated(&state.pool, current.generated.as_ref(), current.rotation.generated.spread).await else { return };
        changed(app, &Appearance::new(current.theme.clone(), current.mode.clone(), current.rotation.clone(), Some(generated)));
        return;
    }
    let theme = next_theme(&current.theme, &current.rotation.mode, THEME_IDS, uuid::Uuid::new_v4().as_u128() as u64);
    if write(&state.pool, THEME_KEY, &theme).await.is_err() {
        return;
    }
    changed(app, &Appearance::new(theme, current.mode.clone(), current.rotation.clone(), None));
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

/// The six key hues' names, in the order a generated rotation cycles through them — for the dialog's legend,
/// rather than a second, hand-kept copy of the list on the frontend that could drift from [`KEY_COLORS`]'s own.
#[tauri::command]
pub fn key_color_names() -> Vec<&'static str> {
    KEY_COLOR_NAMES.to_vec()
}

/// Chooses the theme and the mode of the whole app. **Any window may** — and a rotation that is on goes on, from the theme chosen, with its
/// interval starting again.
#[tauri::command]
pub async fn set_appearance(app: AppHandle, state: tauri::State<'_, AppDbState>, theme: String, mode: String) -> Result<Appearance, String> {
    if !valid_theme(&theme) {
        return Err("That isn't the name of a theme (list_themes says which there are).".to_string());
    }
    if !valid_mode(&mode) {
        return Err("The mode is system, light or dark.".to_string());
    }
    write(&state.pool, THEME_KEY, &theme).await?;
    write(&state.pool, MODE_KEY, &mode).await?;
    let now = read(&state.pool).await;
    schedule(&now.rotation);
    let appearance = Appearance::new(theme, mode, now.rotation, now.generated);
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
    let generated = if rotation.generated.enabled {
        match before.generated {
            Some(existing) if before.rotation.generated.enabled => Some(existing),
            previous => Some(draw_generated(&state.pool, previous.as_ref(), rotation.generated.spread).await?),
        }
    } else {
        None
    };
    schedule(&rotation);
    let appearance = Appearance::new(before.theme, before.mode, rotation, generated);
    changed(&app, &appearance);
    Ok(appearance)
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
        assert_eq!(Appearance::new("x".into(), "dark".into(), r.clone(), None).dark, Some(true));
        assert_eq!(Appearance::new("x".into(), "light".into(), r.clone(), None).dark, Some(false));
        assert_eq!(Appearance::new("x".into(), "system".into(), r, None).dark, None);
    }

    #[test]
    fn the_reserved_keys_are_the_ones_this_module_writes() {
        for key in [THEME_KEY, MODE_KEY, ROTATION_KEY, GENERATED_KEY] {
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
    fn the_interval_is_checked_and_never_shorter_than_half_a_minute() {
        let r = |unit: &str, every: u32| Rotation { enabled: true, mode: "random".into(), unit: unit.into(), every, generated: GeneratedColors::default() };
        assert_eq!(r("seconds", 30).interval().unwrap(), Duration::from_secs(30));
        assert!(r("seconds", 29).interval().unwrap_err().contains("at least 30 seconds"));
        assert_eq!(r("minutes", 1).interval().unwrap(), Duration::from_secs(60));
        assert_eq!(r("hours", 2).interval().unwrap(), Duration::from_secs(7200));
        assert_eq!(r("days", 3).interval().unwrap(), Duration::from_secs(259_200));
        assert!(r("seconds", 0).interval().is_err());
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
        let mut palette = generated_palette(0, 64, [0, 0, 0]);
        for expected in [1u8, 2, 3, 4, 5, 0, 1] {
            let key_index = (palette.key_index as usize + 1) % KEY_COLORS.len();
            palette = generated_palette(key_index, 64, [0, 0, 0]);
            assert_eq!(palette.key_index, expected);
        }
    }

    #[test]
    fn a_generated_palettes_text_always_contrasts_with_its_background() {
        // Every key colour, both extremes of spread, both modes: the automatically-chosen text must clear WCAG AA
        // (4.5:1) against the background and the accent's own text must clear the button-text minimum (3.6:1) —
        // the whole reason `fg`/`accentFg` are computed from the actual colour rather than fixed like a hand-made
        // theme's, since a hand-picked value can't be right for every colour a random draw can produce.
        for key_index in 0..KEY_COLORS.len() {
            for spread in [0u8, 64, 128, 255] {
                for randoms in [[0u32, 0, 0], [u32::MAX, u32::MAX, u32::MAX], [12345, 999_999, 42]] {
                    let palette = generated_palette(key_index, spread, randoms);
                    for colors in [&palette.light, &palette.dark] {
                        let bg = hex_to_rgb(&colors.bg);
                        let fg = hex_to_rgb(&colors.fg);
                        assert!(contrast_ratio(bg, fg) >= 4.5, "key={key_index} spread={spread} bg={} fg={}: {:.2}", colors.bg, colors.fg, contrast_ratio(bg, fg));
                        let accent = hex_to_rgb(&colors.accent);
                        let accent_fg = hex_to_rgb(&colors.accent_fg);
                        assert!(contrast_ratio(accent, accent_fg) >= 3.6, "key={key_index} spread={spread} accent={} accentFg={}: {:.2}", colors.accent, colors.accent_fg, contrast_ratio(accent, accent_fg));
                    }
                }
            }
        }
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
