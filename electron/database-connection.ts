export type PreparedDatabaseSsh = {
  sessionId: string;
  temporary: boolean;
  credentialName?: string;
};

export async function connectWithPreparedSsh<T>(options: {
  prepared: PreparedDatabaseSsh;
  connect: (sessionId: string) => Promise<T>;
  adopt: (sessionId: string) => void;
  cleanup: (sessionId: string) => Promise<void> | void;
}): Promise<T> {
  try {
    const result = await options.connect(options.prepared.sessionId);
    if (options.prepared.temporary) options.adopt(options.prepared.sessionId);
    return result;
  } catch (error) {
    if (options.prepared.temporary) {
      await options.cleanup(options.prepared.sessionId);
    }
    throw error;
  }
}
