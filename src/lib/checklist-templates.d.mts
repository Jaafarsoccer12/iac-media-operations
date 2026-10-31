export function hasChecklistTemplateNameConflict(
  templates: Array<{ id: string; name: string; category?: string }>,
  name: string,
  category: string,
  excludeId?: string,
): boolean;
