import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  machineDeletionLabel,
  machineSpecLabel,
  machineStateIsProblem,
  machineStateLabel,
} from "@t3tools/client-runtime/state/machines";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MachineView, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { machineEnvironment, useThreadMachines } from "../../state/machines";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type MachinesTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadMachinesSheet({ route }: StaticScreenProps<MachinesTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = route.params;
  const machines = useThreadMachines(environmentId, threadId);
  const canRelease = useAtomValue(machineEnvironment.release.permissionAtom(environmentId));
  const release = useAtomCommand(machineEnvironment.release, { reportFailure: false });
  const [releasing, setReleasing] = useState<string | null>(null);
  // The sheet is open briefly; deletion times needn't tick while it is.
  const [now] = useState(() => Date.now());

  const confirmRelease = (machine: MachineView) => {
    void Haptics.selectionAsync();
    Dialog.confirm({
      title: `Release ${machine.name}?`,
      message:
        "The machine is deleted with its disks, and anything on it is lost. If the agent is still using it, its commands there fail.",
      confirmText: "Release",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setReleasing(machine.name);
          const result = await release({
            environmentId,
            input: { threadId, name: machine.name },
          });
          setReleasing(null);
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            Dialog.alert(
              `Could not release ${machine.name}`,
              error instanceof Error ? error.message : "An unexpected error occurred.",
            );
          }
        })();
      },
    });
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {machines.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          This thread has no machines.
        </Text>
      ) : (
        machines.map((machine) => (
          <MachineRow
            key={machine.name}
            machine={machine}
            now={now}
            releasing={releasing === machine.name}
            canRelease={canRelease && releasing === null && machine.state !== "releasing"}
            onRelease={() => confirmRelease(machine)}
          />
        ))
      )}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-machines-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Machines"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Machines" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function MachineRow(props: {
  readonly machine: MachineView;
  readonly now: number;
  readonly releasing: boolean;
  readonly canRelease: boolean;
  readonly onRelease: () => void;
}) {
  const { machine } = props;
  return (
    <View className="flex-row items-center gap-3 border-b border-border py-3.5">
      <SymbolView
        name="server.rack"
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text className="font-t3-medium text-sm text-foreground">{machine.name}</Text>
        <Text
          className={
            machineStateIsProblem(machine.state)
              ? "text-xs text-danger-foreground"
              : "text-xs text-foreground-muted"
          }
        >
          {props.releasing ? "Releasing" : machineStateLabel(machine.state)}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {machineSpecLabel(machine)} · {machineDeletionLabel(machine.expiresAt, props.now)}
        </Text>
        {machine.error ? (
          <Text className="text-xs text-danger-foreground">{machine.error}</Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Release ${machine.name}`}
        accessibilityState={{ disabled: !props.canRelease }}
        disabled={!props.canRelease}
        hitSlop={8}
        onPress={props.onRelease}
        className={`size-9 items-center justify-center rounded-full active:bg-subtle ${props.canRelease ? "" : "opacity-40"}`}
      >
        <SymbolView
          name="trash"
          size={15}
          tintColorClassName="accent-danger-foreground"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
