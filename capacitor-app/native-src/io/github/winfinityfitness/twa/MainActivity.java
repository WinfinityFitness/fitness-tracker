package io.github.winfinityfitness.twa;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
    }
}
