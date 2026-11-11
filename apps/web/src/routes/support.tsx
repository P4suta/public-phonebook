import { createFileRoute } from "@tanstack/react-router";
import { InformationPage } from "../ui/information-page.tsx";
import { serviceInformation } from "../ui/service-information.ts";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [{ title: "使い方とお問い合わせ | Public Phonebook" }],
  }),
  component: () => <InformationPage information={serviceInformation[1]} />,
});
