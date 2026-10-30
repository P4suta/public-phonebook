import { createFileRoute } from "@tanstack/react-router";
import { InformationPage } from "../ui/information-page.tsx";
import { serviceInformation } from "../ui/service-information.ts";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [{ title: "プライバシーについて | Public Phonebook" }],
  }),
  component: () => <InformationPage information={serviceInformation[0]} />,
});
