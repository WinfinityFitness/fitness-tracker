package io.github.winfinityfitness.twa;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Bundled logo splash (stage 1) always holds for this long before handing
    // off to the web app's own smaller logo+text loading screen (stage 2) —
    // fixed, not "however long the WebView happens to take to load", which is
    // all the plain windowBackground splash alone would give us.
    private static final long SPLASH_HOLD_MS = 1500;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
        stashPendingWidgetAction(getIntent());
        // Android 13+ requires POST_NOTIFICATIONS to be explicitly granted, or
        // the background-geolocation plugin's foreground-service notification
        // can silently fail to post once the app backgrounds — taking the
        // tracking it's supposed to keep alive down with it. The geolocation
        // plugin only ever requests the location permission, never this one,
        // so it's requested once here at launch instead.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }

        // The theme's windowBackground (drawable/splash_bg.xml) shows this
        // same logo instantly at launch, before this code even runs — but it
        // gets covered by the WebView the moment Capacitor's Bridge finishes
        // setting up, which can happen well under 2 seconds. This overlay,
        // showing the identical logo, sits on top of that WebView for the
        // rest of the hold time so the transition only ever happens at the
        // 2-second mark, never sooner.
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(Color.parseColor("#060A0D"));
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.splash_logo);
        logo.setScaleType(ImageView.ScaleType.CENTER);
        overlay.addView(logo, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        addContentView(overlay, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay.postDelayed(() -> {
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) parent.removeView(overlay);
        }, SPLASH_HOLD_MS);
    }

    // launchMode="singleTask" (see AndroidManifest.xml) means a widget tap
    // while the app is already running delivers here instead of onCreate —
    // covered separately since onCreate's own getIntent() call wouldn't see it.
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        stashPendingWidgetAction(intent);
    }

    // A widget tap can't run the app's JS directly (may not even be loaded
    // yet on a cold start) — this just stashes which action was tapped so
    // the JS side can ask for it once ready, via
    // WidgetBridgePlugin.getPendingWidgetAction (checked on load and on
    // every visibilitychange — see initWidgetActionHandling in app.js).
    private void stashPendingWidgetAction(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("widget_action");
        if (action == null) return;
        SharedPreferences prefs = getSharedPreferences(WidgetBridgePlugin.PREFS, Context.MODE_PRIVATE);
        prefs.edit().putString("pending_widget_action", action).apply();
    }
}
