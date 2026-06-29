CREATE TABLE "meal_plan_slot_diners" (
	"slot_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_slot_diners_slot_id_user_id_pk" PRIMARY KEY("slot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD COLUMN "guest_count" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_diners" ADD CONSTRAINT "meal_plan_slot_diners_slot_id_meal_plan_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."meal_plan_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_slot_diners" ADD CONSTRAINT "meal_plan_slot_diners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_plan_slot_diners_slot_id_idx" ON "meal_plan_slot_diners" USING btree ("slot_id");--> statement-breakpoint
ALTER TABLE "meal_plan_slots" ADD CONSTRAINT "meal_plan_slots_guest_count_non_negative" CHECK ("meal_plan_slots"."guest_count" >= 0);