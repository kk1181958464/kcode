export function mutationChangedFromOutput(output: string) {
  try {
    const value = JSON.parse(output) as any;
    const candidates = [
      value,
      value?.result,
      ...(Array.isArray(value?.results) ? value.results : []),
    ].filter(Boolean);
    for (const item of candidates) {
      if (Number(item.changedRows) > 0) return true;
      if (Number(item.modifiedCount) > 0) return true;
      if (Number(item.deletedCount) > 0) return true;
      if (Number(item.insertedCount) > 0) return true;
      if (item.insertedId !== undefined && item.insertedId !== null)
        return true;
      if (
        item.insertedIds &&
        typeof item.insertedIds === "object" &&
        Object.keys(item.insertedIds).length > 0
      )
        return true;
      if (Number(item.upsertedCount) > 0) return true;
      if (item.upsertedId !== undefined && item.upsertedId !== null)
        return true;
      if (Number(item.affectedRows) > 0 && item.changedRows === undefined)
        return true;
      if (Number(item.rowCount) > 0 || Number(item.rowsAffected) > 0)
        return true;
    }
  } catch {
    // A successful non-JSON response cannot prove that rows changed.
  }
  return false;
}
