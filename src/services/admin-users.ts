export const ADMIN_USER_PROJECTION = '_id name email phone position employmentType salary role isActive actualDob dateOfJoining archivedAt franchises createdAt';
export type AdminUserSource = {
  _id: unknown; name?: string; email?: string; phone?: string; position?: string; employmentType?: string;
  salary?: number; role?: string; isActive?: boolean; actualDob?: Date; dateOfJoining?: Date; archivedAt?: Date; createdAt?: Date;
};
export function adminUserView(user: AdminUserSource, franchises: Array<{ _id: string; name: string; }>) {
  return {
    _id: String(user._id), name: user.name, email: user.email, phone: user.phone, position: user.position,
    employmentType: user.employmentType, salary: user.salary, role: user.role, isActive: user.isActive !== false,
    actualDob: user.actualDob, dateOfJoining: user.dateOfJoining, archivedAt: user.archivedAt, franchises, createdAt: user.createdAt,
  };
}
export function pageValue(value: unknown, fallback: number): number {
  return Math.max(1, Number.parseInt(String(value ?? fallback), 10) || fallback);
}