import { createMachineEnvironmentAtoms } from "@t3tools/client-runtime/state/machines";

import { connectionAtomRuntime } from "../connection/runtime";

export const machineEnvironment = createMachineEnvironmentAtoms(connectionAtomRuntime);
