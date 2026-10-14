import JobView from "./job-view";

export default function JobPage({ params }: { params: { id: string } }) {
  return <JobView id={params.id} />;
}
