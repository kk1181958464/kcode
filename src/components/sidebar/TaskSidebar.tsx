import {
  memo,
  useDeferredValue,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { TaskRecord } from "../../models";
import {
  projectSidebarWorkspaceGroups,
  type SidebarProjection,
} from "../../sidebar-projection";
import { taskRuntimeStore } from "../../task-runtime-store";
import { Sidebar, type SidebarProps } from "./Sidebar";

type TaskSidebarProps = Omit<SidebarProps, "workspaceGroups"> & {
  tasks: readonly TaskRecord[];
};

/** Keep runtime subscriptions local so background tasks do not rerender App. */
export const TaskSidebar = memo(function TaskSidebar({
  tasks,
  ...props
}: TaskSidebarProps) {
  const runtimeRevision = useSyncExternalStore(
    taskRuntimeStore.subscribe,
    taskRuntimeStore.getSnapshot,
    taskRuntimeStore.getSnapshot,
  );
  const deferredQuery = useDeferredValue(props.taskQuery);
  const projectionRef = useRef<SidebarProjection | undefined>(undefined);
  const workspaceGroups = useMemo(() => {
    const projection = projectSidebarWorkspaceGroups(
      taskRuntimeStore.overlayTasks(tasks),
      deferredQuery,
      props.showArchived,
      projectionRef.current,
    );
    projectionRef.current = projection;
    return projection.workspaceGroups;
  }, [tasks, deferredQuery, props.showArchived, runtimeRevision]);

  return <Sidebar {...props} workspaceGroups={workspaceGroups} />;
});
