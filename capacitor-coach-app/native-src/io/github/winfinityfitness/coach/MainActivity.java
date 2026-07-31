package io.github.winfinityfitness.coach;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Same fix as capacitor-app's own MainActivity.java (see that file's
    // comment for the full rationale): Capacitor's default back-button
    // handling falls straight through to finishing the Activity -- a hard
    // exit -- regardless of the WebView's own navigation history. Routing
    // it through the WebView's canGoBack()/goBack() first makes in-app
    // history (screen changes, closing overlays) reachable via back;
    // only once there's truly nothing left to go back through does this
    // send the app to the background (moveTaskToBack), never a hard exit
    // -- same behavior as any well-behaved Android app, only actually
    // closed by swiping it away in the recent-apps drawer.
    @Override
    public void onBackPressed() {
        if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
            bridge.getWebView().goBack();
        } else {
            moveTaskToBack(true);
        }
    }
}
