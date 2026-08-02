export const MAX_REMOTE_DEVICE_NAME_LENGTH = 64;

export function normalizeRemoteDeviceName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("电脑名称不能为空");
  if (name.length > MAX_REMOTE_DEVICE_NAME_LENGTH)
    throw new Error(`电脑名称不能超过 ${MAX_REMOTE_DEVICE_NAME_LENGTH} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw new Error("电脑名称不能包含控制字符");
  return name;
}
