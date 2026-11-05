import { Database } from "./db.js";

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

export interface ProjectSummary {
  project_id: number;
  budget_cents: number;
  approved_milestones_cents: number;
  pending_milestones_cents: number;
  approved_change_cents: number;
  projected_total_cents: number;
  remaining_cents: number;
}

function assertPositive(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new ValidationError(`${field} must be a positive integer`);
}

function assertDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be YYYY-MM-DD`);
  }
}

export class DeliveryService {
  constructor(private readonly db: Database) {}

  private async activity(projectId: number, action: string, detail = ""): Promise<void> {
    await this.db.query("INSERT INTO activities (project_id, action, detail) VALUES ($1, $2, $3)", [projectId, action, detail]);
  }

  async createClient(code: string, name: string) {
    if (!code.trim() || !name.trim()) throw new ValidationError("client code and name are required");
    const existing = await this.db.query("SELECT id FROM clients WHERE code = $1", [code]);
    if (existing.length) throw new ValidationError("client code already exists");
    const rows = await this.db.query<{ id: number; code: string; name: string }>(
      "INSERT INTO clients (code, name) VALUES ($1, $2) RETURNING id, code, name",
      [code, name]
    );
    return rows[0];
  }

  async createProject(clientId: number, code: string, name: string, budgetCents: number, startDate: string, endDate: string) {
    if (!code.trim() || !name.trim()) throw new ValidationError("project code and name are required");
    assertPositive(budgetCents, "budget_cents");
    assertDate(startDate, "start_date");
    assertDate(endDate, "end_date");
    if (endDate < startDate) throw new ValidationError("end_date cannot be before start_date");
    const client = await this.db.query("SELECT id FROM clients WHERE id = $1", [clientId]);
    if (!client.length) throw new NotFoundError("client not found");
    const existing = await this.db.query("SELECT id FROM projects WHERE code = $1", [code]);
    if (existing.length) throw new ValidationError("project code already exists");
    const rows = await this.db.query<{ id: number; code: string; status: string }>(
      "INSERT INTO projects (client_id, code, name, budget_cents, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, code, status",
      [clientId, code, name, budgetCents, startDate, endDate]
    );
    await this.activity(rows[0].id, "project_created", code);
    return rows[0];
  }

  async addMilestone(projectId: number, name: string, amountCents: number, dueDate: string) {
    if (!name.trim()) throw new ValidationError("milestone name is required");
    assertPositive(amountCents, "amount_cents");
    assertDate(dueDate, "due_date");
    const project = await this.db.query("SELECT id, status FROM projects WHERE id = $1", [projectId]);
    if (!project.length) throw new NotFoundError("project not found");
    if (project[0].status !== "active") throw new ValidationError("project is not active");
    const existing = await this.db.query("SELECT id FROM milestones WHERE project_id = $1 AND name = $2", [projectId, name]);
    if (existing.length) throw new ValidationError("milestone already exists");
    const rows = await this.db.query<{ id: number; status: string }>(
      "INSERT INTO milestones (project_id, name, amount_cents, due_date) VALUES ($1,$2,$3,$4) RETURNING id, status",
      [projectId, name, amountCents, dueDate]
    );
    await this.activity(projectId, "milestone_added", name);
    return rows[0];
  }

  async approveMilestone(milestoneId: number) {
    const rows = await this.db.query<{ id: number; project_id: number; status: string }>(
      "SELECT id, project_id, status FROM milestones WHERE id = $1",
      [milestoneId]
    );
    if (!rows.length) throw new NotFoundError("milestone not found");
    if (rows[0].status === "approved") return { id: rows[0].id, status: "approved", unchanged: true };
    await this.db.query("UPDATE milestones SET status = 'approved', approved_at = now() WHERE id = $1", [milestoneId]);
    await this.activity(rows[0].project_id, "milestone_approved", String(milestoneId));
    return { id: rows[0].id, status: "approved", unchanged: false };
  }

  async proposeChange(projectId: number, title: string, scope: string, costImpactCents: number) {
    if (!title.trim() || !scope.trim()) throw new ValidationError("change title and scope are required");
    if (!Number.isInteger(costImpactCents)) throw new ValidationError("cost_impact_cents must be an integer");
    const project = await this.db.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!project.length) throw new NotFoundError("project not found");
    const rows = await this.db.query<{ id: number; status: string }>(
      "INSERT INTO change_requests (project_id, title, scope, cost_impact_cents) VALUES ($1,$2,$3,$4) RETURNING id, status",
      [projectId, title, scope, costImpactCents]
    );
    await this.activity(projectId, "change_proposed", title);
    return rows[0];
  }

  async decideChange(changeId: number, approved: boolean) {
    const rows = await this.db.query<{ id: number; project_id: number; status: string }>(
      "SELECT id, project_id, status FROM change_requests WHERE id = $1",
      [changeId]
    );
    if (!rows.length) throw new NotFoundError("change request not found");
    const status = approved ? "approved" : "rejected";
    if (rows[0].status === status) return { id: rows[0].id, status, unchanged: true };
    await this.db.query("UPDATE change_requests SET status = $1 WHERE id = $2", [status, changeId]);
    await this.activity(rows[0].project_id, approved ? "change_approved" : "change_rejected", String(changeId));
    return { id: rows[0].id, status, unchanged: false };
  }

  async summary(projectId: number): Promise<ProjectSummary> {
    const project = await this.db.query<{ id: number; budget_cents: number }>("SELECT id, budget_cents FROM projects WHERE id = $1", [projectId]);
    if (!project.length) throw new NotFoundError("project not found");
    const milestones = await this.db.query<{ status: string; amount_cents: number }>(
      "SELECT status, amount_cents FROM milestones WHERE project_id = $1",
      [projectId]
    );
    const changes = await this.db.query<{ cost_impact_cents: number }>(
      "SELECT cost_impact_cents FROM change_requests WHERE project_id = $1 AND status = 'approved'",
      [projectId]
    );
    const approved = milestones.filter((m) => m.status === "approved").reduce((sum, m) => sum + m.amount_cents, 0);
    const pending = milestones.filter((m) => m.status === "pending").reduce((sum, m) => sum + m.amount_cents, 0);
    const change = changes.reduce((sum, c) => sum + c.cost_impact_cents, 0);
    const budget = project[0].budget_cents;
    return {
      project_id: projectId,
      budget_cents: budget,
      approved_milestones_cents: approved,
      pending_milestones_cents: pending,
      approved_change_cents: change,
      projected_total_cents: approved + pending + change,
      remaining_cents: budget - (approved + pending + change)
    };
  }

  async activities(projectId: number) {
    const project = await this.db.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!project.length) throw new NotFoundError("project not found");
    return this.db.query("SELECT action, detail, at FROM activities WHERE project_id = $1 ORDER BY id", [projectId]);
  }
}
