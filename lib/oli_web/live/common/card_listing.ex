defmodule OliWeb.Common.CardListing do
  use Surface.Component

  import OliWeb.Common.SourceImage

  alias OliWeb.Common.Utils
  alias OliWeb.Delivery.SelectSource.TableModel

  prop model, :struct, required: true
  prop selected, :event, required: true

  def render(assigns) do
    ~F"""
    <div class="select-sources">
      <div class="card-deck mr-0 ml-0">
        {#for item <- @model.rows}
          <a :on-click={@selected} class="course-card-link mb-2" phx-value-id={action_id(item)}>
            <div class="card mb-2 mr-1 ml-1 h-100">
              <img src={cover_image(item)} class="card-img-top" alt="course image">
              <div class="card-body">
                <h5 class="card-title text-primary" title={render_title_column(item)}>{render_title_column(item)}</h5>
                <div class="fade-text"><p class="card-text small">{render_description(item)}</p></div>
              </div>
              <div class="card-footer bg-transparent d-flex justify-content-between align-items-center border-0">
                <div class="badge badge-success mr-5">{TableModel.render_payment_column(assigns, item, nil)}</div>
                <div class="small-date text-muted">{render_date(item, Map.merge(assigns, @model.data))}</div>
              </div>
            </div>
          </a>
        {/for}
      </div>
    </div>
    """
  end

  defp render_title_column(item) do
    if TableModel.is_product?(item),
      do: item.title,
      else:  item.project.title
  end

  defp render_description(item) do
    if TableModel.is_product?(item),
      do: item.description,
      else:  item.project.description
  end

  defp render_date(item, assigns) do
    Utils.render_date(item, :inserted_at, Map.get(assigns, :context))
  end

  defp action_id(item) do
    if TableModel.is_product?(item),
      do: "product:#{item.id}",
      else: "publication:#{item.id}"
  end
end
