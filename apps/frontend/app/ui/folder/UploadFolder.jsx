import Folder from "./Folder";

const pages = [{ title: "PDF" }, { title: "PDF" }];

export default function UploadFolder({ dragging }) {
  return (
    <div className="upload-folder-preview" inert aria-hidden="true">
      <Folder
        items={pages}
        color="#4189d6"
        theme="light"
        size={0.3}
        layout="stack"
        key={dragging ? "receiving" : "idle"}
        intro={dragging}
        open={dragging}
        peek={false}
        draggable={false}
        zoomOnClick={false}
        tilt={0}
      />
    </div>
  );
}
