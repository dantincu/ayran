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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rotation {
    pub enabled: bool,
    /// `ascending` (the next theme of the catalog), `descending` (the previous) or `random` (any other than the current one).
    pub mode: String,
    /// `seconds`, `minutes`, `hours` or `days`, and how many of them.
    pub unit: String,
    pub every: u32,
}

impl Default for Rotation {
    fn default() -> Self {
        Rotation { enabled: false, mode: "ascending".into(), unit: "minutes".into(), every: 5 }
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

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Appearance {
    pub theme: String,
    /// `system`, `light` or `dark`.
    pub mode: String,
    /// `Some(true)` for a manual dark mode, `Some(false)` for a manual light one, `None` when the device decides.
    pub dark: Option<bool>,
    pub rotation: Rotation,
}

impl Appearance {
    fn new(theme: String, mode: String, rotation: Rotation) -> Self {
        let dark = match mode.as_str() {
            "dark" => Some(true),
            "light" => Some(false),
            _ => None,
        };
        Appearance { theme, mode, dark, rotation }
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

async fn read(pool: &sqlx::SqlitePool) -> Appearance {
    async fn get(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM global_settings WHERE key = ?1").bind(key).fetch_optional(pool).await.ok().flatten()
    }
    let theme = get(pool, THEME_KEY).await.filter(|t| valid_theme(t)).unwrap_or_else(|| DEFAULT_THEME.to_string());
    let mode = get(pool, MODE_KEY).await.filter(|m| valid_mode(m)).unwrap_or_else(|| "system".to_string());
    let rotation = get(pool, ROTATION_KEY).await.and_then(|json| serde_json::from_str::<Rotation>(&json).ok()).filter(|r| r.interval().is_ok()).unwrap_or_default();
    Appearance::new(theme, mode, rotation)
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

/// One look of the rotation's clock: moves to the next theme when the interval has passed.
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
    let theme = next_theme(&current.theme, &current.rotation.mode, THEME_IDS, uuid::Uuid::new_v4().as_u128() as u64);
    let state = app.state::<AppDbState>();
    if write(&state.pool, THEME_KEY, &theme).await.is_err() {
        return;
    }
    schedule(&current.rotation);
    changed(app, &Appearance::new(theme, current.mode.clone(), current.rotation.clone()));
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
    let rotation = read(&state.pool).await.rotation;
    schedule(&rotation);
    let appearance = Appearance::new(theme, mode, rotation);
    changed(&app, &appearance);
    Ok(appearance)
}

/// Sets the rotation through the themes. **Admin-app only.**
#[tauri::command]
pub async fn set_appearance_rotation(
    window: crate::window_host::CallerWindow,
    app: AppHandle,
    state: tauri::State<'_, AppDbState>,
    rotation: Rotation,
) -> Result<Appearance, String> {
    crate::window_host::require_admin(&window)?;
    rotation.interval()?;
    write(&state.pool, ROTATION_KEY, &serde_json::to_string(&rotation).map_err(|e| e.to_string())?).await?;
    schedule(&rotation);
    let now = read(&state.pool).await;
    let appearance = Appearance::new(now.theme, now.mode, rotation);
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
        assert_eq!(Appearance::new("x".into(), "dark".into(), r.clone()).dark, Some(true));
        assert_eq!(Appearance::new("x".into(), "light".into(), r.clone()).dark, Some(false));
        assert_eq!(Appearance::new("x".into(), "system".into(), r).dark, None);
    }

    #[test]
    fn the_reserved_keys_are_the_ones_this_module_writes() {
        for key in [THEME_KEY, MODE_KEY, ROTATION_KEY] {
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
        let r = |unit: &str, every: u32| Rotation { enabled: true, mode: "random".into(), unit: unit.into(), every };
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
}
