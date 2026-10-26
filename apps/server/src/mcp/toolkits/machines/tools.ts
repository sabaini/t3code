import {
  MachineToolAcquireInput,
  MachineToolError,
  MachineToolListInput,
  MachineToolListResult,
  MachineToolMachineResult,
  MachineToolNameInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as MachineService from "../../../machines/MachineService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProviderRegistry.ProviderRegistry,
  MachineService.MachineService,
];

const MachineToolFailure = Schema.Union([MachineToolError, OrchestratorMcpFailure]);

const MachineListTool = Tool.make("machine_list", {
  description: "List this thread's test machines and the project's machine profiles.",
  parameters: MachineToolListInput,
  success: MachineToolListResult,
  failure: MachineToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List machines")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MachineAcquireTool = Tool.make("machine_acquire", {
  description:
    "Create a disposable LXD VM or container from a profile. Waits up to 40 seconds for it to boot and returns its ssh command.",
  parameters: MachineToolAcquireInput,
  success: MachineToolMachineResult,
  failure: MachineToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create machine")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MachineWaitTool = Tool.make("machine_wait", {
  description: "Wait up to 40 seconds for a machine to be ready, starting it if it's stopped.",
  parameters: MachineToolNameInput,
  success: MachineToolMachineResult,
  failure: MachineToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Wait for machine")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const MachineReleaseTool = Tool.make("machine_release", {
  description: "Delete a machine and its disks.",
  parameters: MachineToolNameInput,
  success: Schema.Record(Schema.String, Schema.Never).annotate({
    description: "The machine was released.",
  }),
  failure: MachineToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Release machine")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const MachineToolkit = Toolkit.make(
  MachineListTool,
  MachineAcquireTool,
  MachineWaitTool,
  MachineReleaseTool,
);
