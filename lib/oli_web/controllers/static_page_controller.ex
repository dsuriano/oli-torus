defmodule OliWeb.StaticPageController do
  use OliWeb, :controller

  import Oli.Branding

  alias Oli.Accounts

  def index(conn, _params) do
    render(conn, "index.html")
  end

  def unauthorized(conn, _params) do
    render(conn, "unauthorized.html")
  end

  def not_found(conn, _params) do
    render(conn, "not_found.html")
  end

  def keep_alive(conn, _params) do
    conn
    |> send_resp(200, "Ok")
  end

  def timezone(conn, %{"local_tz" => browser_timezone}) do
    conn
    |> put_session("browser_timezone", browser_timezone)
    |> send_resp(200, "Ok")
  end

  def site_webmanifest(conn, _params) do
    conn
    |> json(%{
      "name" => brand_name(),
      "short_name" => brand_name(),
      "icons" => [
        %{
          "src" => favicons("android-chrome-192x192.png"),
          "sizes" => "192x192",
          "type" => "image/png"
        },
        %{
          "src" => favicons("android-chrome-512x512.png"),
          "sizes" => "512x512",
          "type" => "image/png"
        }
      ],
      "theme_color" => "#ffffff",
      "background_color" => "#ffffff",
      "display" => "standalone"
    })
  end

  def set_session(conn, %{"dismissed_message" => message_id}) do
    dismissed_messages = get_session(conn, :dismissed_messages) || []
    id = String.to_integer(message_id)

    conn
    |> put_session(:dismissed_messages, [id | dismissed_messages])
    |> send_resp(200, "Ok")
  end

  def update_timezone(conn, %{"timezone" => timezone, "redirect_to" => redirect_to}) do
    redirect_to = validate_path(conn, redirect_to)

    conn =
      with {:ok, conn} <- maybe_update_author(conn, timezone),
           {:ok, conn} <- maybe_update_user(conn, timezone) do
        put_flash(conn, :info, "Timezone updated successfully.")
      else
        {:error, _} ->
          put_flash(conn, :error, "There was an error updating the timezone.")
      end

    redirect(conn, to: redirect_to)
  end

  defp validate_path(_, "/" <> _ = path), do: path
  defp validate_path(conn, _), do: Routes.static_page_path(conn, :index)

  defp maybe_update_author(%Plug.Conn{assigns: %{current_author: author}} = conn, timezone)
       when not is_nil(author) do
    case Accounts.set_author_preference(author, :timezone, timezone) do
      {:ok, _} -> {:ok, conn}
      {:error, error} -> {:error, error}
    end
  end

  defp maybe_update_author(conn, _timezone), do: {:ok, conn}

  defp maybe_update_user(%Plug.Conn{assigns: %{current_user: user}} = conn, timezone)
       when not is_nil(user) do
    case Accounts.set_user_preference(user, :timezone, timezone) do
      {:ok, _} -> {:ok, conn}
      {:error, error} -> {:error, error}
    end
  end

  defp maybe_update_user(conn, _timezone), do: {:ok, conn}
end
