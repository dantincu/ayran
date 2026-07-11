use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

#[cfg(target_os = "android")]
mod mobile;

pub use error::Error;
pub use models::CaptureResponse;

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(target_os = "android")]
use mobile::ScreenCapture;

#[tauri::command]
async fn capture<R: Runtime>(app: tauri::AppHandle<R>) -> Result<CaptureResponse> {
    #[cfg(target_os = "android")]
    {
        app.state::<ScreenCapture<R>>().inner().capture().await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(Error::UnsupportedPlatform)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screen-capture")
        .invoke_handler(tauri::generate_handler![capture])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let screen_capture = mobile::init(_app, _api)?;
                _app.manage(screen_capture);
            }
            Ok(())
        })
        .build()
}
