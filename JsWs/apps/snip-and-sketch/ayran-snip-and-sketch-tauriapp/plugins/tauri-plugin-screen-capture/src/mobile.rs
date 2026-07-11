use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::CaptureResponse;
use crate::Result;

const PLUGIN_IDENTIFIER: &str = "io.ayran.snipandsketch.screencapture";

pub struct ScreenCapture<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<ScreenCapture<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ScreenCapturePlugin")?;
    Ok(ScreenCapture(handle))
}

impl<R: Runtime> ScreenCapture<R> {
    pub async fn capture(&self) -> Result<CaptureResponse> {
        self.0
            .run_mobile_plugin_async("capture", ())
            .await
            .map_err(Into::into)
    }
}
