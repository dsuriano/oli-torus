defmodule OliWeb.ProjectControllerTest do
  use OliWeb.ConnCase
  alias Oli.Repo
  alias Oli.Authoring.Course.Project
  alias Oli.Activities
  alias Oli.Activities.ActivityRegistrationProject

  import Oli.Factory

  @basic_get_routes [:overview, :publish, :insights]
  setup [:author_project_conn]
  @valid_attrs %{title: "default title"}
  @invalid_attrs %{title: ""}
  @update_attrs %{description: "default description"}

  describe "authorization" do
    test "all get routes redirect to workspace path when attempting to view a project that does not exist",
         %{conn: conn} do
      @basic_get_routes
      |> Enum.each(fn path -> unauthorized_redirect(conn, path, "does not exist") end)
    end
  end

  test "author can not access projects that do not belong to them", %{conn: conn, author: author} do
    {:ok, author: _author2, project: project2} = author_project_fixture()
    conn = Plug.Test.init_test_session(conn, current_author_id: author.id)

    @basic_get_routes
    |> Enum.each(fn path -> unauthorized_redirect(conn, path, project2.slug) end)
  end

  describe "projects" do
    # this test demonstrates the valid case where an author has multiple user accounts associated
    # (consider an authoring account shared across lms or independent instructor accounts)
    test "multiple linked user accounts still renders properly", %{conn: conn, author: author} do
      _user_associated = insert(:user, author: author)
      _user2_associated = insert(:user, author: author)

      conn = get(conn, Routes.live_path(OliWeb.Endpoint, OliWeb.Projects.ProjectsLive))

      assert html_response(conn, 200) =~ "<h3>Projects</h3>"
    end
  end

  describe "overview" do
    test "displays the page", %{conn: conn, project: project} do
      publisher = Oli.Inventories.get_publisher(project.publisher_id)
      custom_act = Activities.get_registration_by_slug("oli_image_coding")

      %ActivityRegistrationProject{}
      |> ActivityRegistrationProject.changeset(%{
        activity_registration_id: custom_act.id,
        project_id: project.id
      })
      |> Repo.insert()

      conn = get(conn, Routes.project_path(conn, :overview, project.slug))

      response = html_response(conn, 200)
      assert response =~ "Overview"
      assert response =~ project.title
      assert response =~ publisher.name
    end
  end

  describe "publish" do
    test "displays the page", %{conn: conn, project: project} do
      conn = get(conn, Routes.project_path(conn, :publish, project.slug))
      assert html_response(conn, 200) =~ "Publish"
    end

    test "displays the published date", %{project: project} = context do
      {:ok, conn: conn, context: session_context} = set_timezone(context)
      {:ok, publication} = Oli.Publishing.publish_project(project, "New publication")

      conn = get(conn, Routes.project_path(conn, :publish, project.slug))
      assert html_response(conn, 200) =~ "Publish"

      assert html_response(conn, 200) =~
               "Last published <strong>" <>
                 OliWeb.Common.Utils.render_date(publication, :published, session_context)
    end
  end

  describe "insights" do
    test "displays the page", %{conn: conn, project: project} do
      conn = get(conn, Routes.project_path(conn, :insights, project.slug))
      assert html_response(conn, 200) =~ "Insights"
    end
  end

  describe "create project" do
    test "redirects to page index when data is valid", %{conn: conn} do
      conn = post(conn, Routes.project_path(conn, :create), project: @valid_attrs)
      assert html_response(conn, 302) =~ "/project/"
    end

    test "redirects back to workspace when data is invalid", %{conn: conn} do
      conn = post(conn, Routes.project_path(conn, :create), project: @invalid_attrs)
      assert html_response(conn, 302) =~ "/projects"
    end
  end

  describe "delete project" do
    test "redirects back to workspace when project is deleted", %{conn: conn, project: project} do
      conn = delete(conn, Routes.project_path(conn, :delete, project), title: project.title)
      assert html_response(conn, 302) =~ "/projects"
    end
  end

  describe "update project" do
    test "performs update when data is valid", %{conn: conn, project: project} do
      put(conn, Routes.project_path(conn, :update, project), project: @update_attrs)
      assert Repo.get_by(Project, @update_attrs)
    end

    test "prevents update when data is invalid", %{conn: conn, project: project} do
      put(conn, Routes.project_path(conn, :update, project), project: @invalid_attrs)
      refute Repo.get_by(Project, @invalid_attrs)
    end

    test "redirects on success", %{conn: conn, project: project} do
      conn = put(conn, Routes.project_path(conn, :update, project), project: @update_attrs)
      assert redirected_to(conn) =~ Routes.project_path(conn, :overview, project)
    end

    test "does not redirect on failure", %{conn: conn, project: project} do
      conn = put(conn, Routes.project_path(conn, :update, project), project: @invalid_attrs)
      refute conn.assigns.changeset.valid?
      assert html_response(conn, 200) =~ "Overview"
    end
  end

  defp unauthorized_redirect(conn, path, project) do
    conn = get(conn, Routes.project_path(conn, path, project))
    assert redirected_to(conn) == Routes.live_path(OliWeb.Endpoint, OliWeb.Projects.ProjectsLive)
  end
end
