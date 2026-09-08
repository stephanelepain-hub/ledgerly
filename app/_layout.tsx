import "@/global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SQLiteProvider } from "expo-sqlite";
import { useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { Platform } from "react-native";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

import { AccountingProvider } from "@/lib/accounting-context";
import { migrateDatabase } from "@/lib/db";

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  // Ensure minimum padding for top and bottom on mobile
  const providerInitialMetrics = useMemo(() => {
    const metrics = initialWindowMetrics ?? {
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      frame: { x: 0, y: 0, width: 0, height: 0 },
    };
    return {
      ...metrics,
      insets: {
        ...metrics.insets,
        top: Math.max(metrics.insets.top, 16),
        bottom: Math.max(metrics.insets.bottom, 12),
      },
    };
  }, []);

  const accountingContent = (
    <AccountingProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="transaction-form"
          options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
        />
        <Stack.Screen
          name="receipt-review"
          options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
        />
      </Stack>
      <StatusBar style="auto" />
    </AccountingProvider>
  );

  const storageContent = Platform.OS === "web" ? (
    accountingContent
  ) : (
    <SQLiteProvider databaseName="ledgerly.db" onInit={migrateDatabase}>
      {accountingContent}
    </SQLiteProvider>
  );

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>
        <GestureHandlerRootView style={{ flex: 1 }}>{storageContent}</GestureHandlerRootView>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
