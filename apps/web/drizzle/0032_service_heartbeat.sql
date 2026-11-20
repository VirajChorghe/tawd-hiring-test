CREATE TABLE "service_heartbeat" (
	"service" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
