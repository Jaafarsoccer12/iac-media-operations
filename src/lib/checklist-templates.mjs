export function hasChecklistTemplateNameConflict(templates, name, category, excludeId) {
  const normalizedName = name.trim().toLocaleLowerCase();
  const normalizedCategory = category.trim().toLocaleLowerCase();
  return templates.some((template) => {
    const templateName = template.name.trim().toLocaleLowerCase();
    const templateCategory = (template.category ?? "Pre-event").trim().toLocaleLowerCase();
    return template.id !== excludeId && templateName === normalizedName && templateCategory === normalizedCategory;
  });
}
