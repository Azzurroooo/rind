package dev.rind.mobile;

import android.content.res.Configuration;
import android.graphics.Color;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Older WebViews leave native padding behind the system bars. Match that
// padding to the Web theme after SystemBars updates the icon appearance.
@CapacitorPlugin(name = "RindAppearance")
public class RindAppearancePlugin extends Plugin {
    private Integer backgroundColor;

    @PluginMethod
    public void setBackground(PluginCall call) {
        final int color;
        try {
            color = Color.parseColor(call.getString("color", ""));
        } catch (IllegalArgumentException exception) {
            call.reject("Invalid background color.");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            backgroundColor = color;
            applyBackground();
            call.resolve();
        });
    }

    private void applyBackground() {
        if (backgroundColor != null) {
            getActivity().getWindow().getDecorView().setBackgroundColor(backgroundColor);
        }
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration configuration) {
        // SystemBars reapplies the OS theme on rotation; run after its callbacks.
        getActivity().getWindow().getDecorView().post(this::applyBackground);
    }

    @Override
    protected void handleOnResume() {
        getActivity().getWindow().getDecorView().post(this::applyBackground);
    }
}
