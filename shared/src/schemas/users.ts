import { z } from 'zod';

// Household-member list item used by the planner's chef dropdown. In the
// single-household MVP (DEC-17) every user is implicitly a member of
// CURRENT_HOUSEHOLD_ID; the procedure returns the auth users directly. When
// multi-household lands, this schema is unchanged — only the procedure's
// scoping query grows.
export const householdMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
});
export type HouseholdMember = z.infer<typeof householdMemberSchema>;

export const listHouseholdMembersResultSchema = z.object({
  members: z.array(householdMemberSchema),
});
export type ListHouseholdMembersResult = z.infer<
  typeof listHouseholdMembersResultSchema
>;
